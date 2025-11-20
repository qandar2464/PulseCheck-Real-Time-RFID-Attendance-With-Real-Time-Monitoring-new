// functions/index.js
'use strict';

const functions = require('firebase-functions'); // ^5.x (Gen2)
const admin = require('firebase-admin');

/**
 * Init Admin SDK (idempotent)
 */
try {
  admin.app();
} catch {
  admin.initializeApp();
}

const db = admin.database();

/**
 * Utilities
 */
const REGION = 'asia-southeast1'; // selarikan dengan lokasi RTDB projek
const nowMs = () => Date.now();

/**
 * Callable: createOrUpdateSession
 * - Hanya untuk admin (custom claim: { admin: true })
 * - Buat/kemas kini session
 * - Pastikan wujudkan rangka awal summary/{sessionId}
 *
 * data: { sessionId?, subjectCode, subjectName?, hallId, startAt, endAt }
 * return: { sessionId }
 */
exports.createOrUpdateSession = functions
  .region(REGION)
  .https.onCall(async (data, ctx) => {
    // Auth & role
    if (!ctx.auth?.token?.admin) {
      throw new functions.https.HttpsError('permission-denied', 'Admin only');
    }

    // Validate
    const { sessionId, subjectCode, subjectName, hallId, startAt, endAt } = data || {};
    if (!subjectCode || !hallId || !startAt || !endAt) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Missing subjectCode/hallId/startAt/endAt'
      );
    }
    if (endAt <= startAt) {
      throw new functions.https.HttpsError('invalid-argument', 'endAt must be > startAt');
    }

    // Upsert
    const sid = sessionId || db.ref('sessions').push().key;
    await db.ref(`sessions/${sid}`).update({
      subjectCode,
      subjectName: subjectName || subjectCode,
      hallId,
      startAt,
      endAt,
      isLocked: false,
    });

    // Bootstrap summary if missing
    await db.ref(`summary/${sid}`).transaction((cur) => {
      return (
        cur || {
          counts: { ENTRY: 0, TOILET_OUT: 0, TOILET_IN: 0, EXIT: 0 },
          uniquePresent: 0,
          completed: 0,
          updatedAt: nowMs(),
        }
      );
    });

    return { sessionId: sid };
  });

/**
 * Callable: lockSession
 * - Hanya untuk admin
 *
 * data: { sessionId, locked }
 * return: { ok: true }
 */
exports.lockSession = functions
  .region(REGION)
  .https.onCall(async (data, ctx) => {
    if (!ctx.auth?.token?.admin) {
      throw new functions.https.HttpsError('permission-denied', 'Admin only');
    }
    const { sessionId, locked } = data || {};
    if (!sessionId) {
      throw new functions.https.HttpsError('invalid-argument', 'sessionId required');
    }
    await db.ref(`sessions/${sessionId}/isLocked`).set(!!locked);
    return { ok: true };
  });

/**
 * RTDB Trigger: onAttendanceCreate
 * - Enforce window sesi + isLocked
 * - Normalize serverTimestamp
 * - Aggregate summary/{sessionId}
 */
exports.onAttendanceCreate = functions
  .region(REGION)
  .database.ref('/attendance/{id}')
  .onCreate(async (snap, ctx) => {
    const r = snap.val();
    const serverNow = nowMs();

    // Basic required fields
    if (!r || !r.sessionId || !r.status || !r.hallId || !r.studentId) {
      // Drop invalid
      await snap.ref.remove();
      return null;
    }

    // Get session
    const sess = (await db.ref(`sessions/${r.sessionId}`).get()).val();
    if (!sess) {
      await snap.ref.remove();
      return null;
    }

    // Window check (+15 min grace)
    const grace = 15 * 60 * 1000;
    if (sess.isLocked || serverNow < sess.startAt || serverNow > (sess.endAt + grace)) {
      await snap.ref.remove();
      return null;
    }

    // Normalize timestamp (server truth)
    await snap.ref.child('serverTimestamp').set(serverNow);

    // Aggregate summary atomically
    const sumRef = db.ref(`summary/${r.sessionId}`);
    await sumRef.transaction((cur) => {
      cur =
        cur || {
          counts: { ENTRY: 0, TOILET_OUT: 0, TOILET_IN: 0, EXIT: 0 },
          uniquePresent: 0,
          completed: 0,
        };
      cur.counts = cur.counts || {};
      cur.counts[r.status] = (cur.counts[r.status] || 0) + 1;

      if (r.status === 'ENTRY') cur.uniquePresent = (cur.uniquePresent || 0) + 1;
      if (r.status === 'EXIT') cur.completed = (cur.completed || 0) + 1;

      cur.updatedAt = serverNow;
      return cur;
    });

    return null;
  });

/**
 * RTDB Trigger: onAdminOps
 * - Audit-pipeline untuk operasi admin terkawal
 * - Contoh operasi: amendAttendance
 *
 * adminOps/{opId}:
 * {
 *   type: "amendAttendance",
 *   requesterUid: "...",
 *   requestedBy: "email@domain",
 *   sessionId: "...",
 *   payload: { ...attendanceLikeDoc... }
 * }
 */
exports.onAdminOps = functions
  .region(REGION)
  .database.ref('/adminOps/{opId}')
  .onCreate(async (snap, ctx) => {
    const op = snap.val() || {};
    const serverNow = nowMs();

    try {
      // Only admin can issue
      const requesterUid = op.requesterUid || '';
      const user = requesterUid ? await admin.auth().getUser(requesterUid) : null;
      const isAdmin = !!(user && user.customClaims && user.customClaims.admin);

      if (!isAdmin) {
        await snap.ref.update({
          status: 'rejected',
          reason: 'not admin',
          reviewedAt: serverNow,
        });
        return null;
      }

      if (op.type === 'amendAttendance') {
        // Validate payload
        const p = op.payload || {};
        if (
          !op.sessionId ||
          !p.status ||
          !/^(ENTRY|TOILET_OUT|TOILET_IN|EXIT)$/.test(p.status)
        ) {
          await snap.ref.update({
            status: 'rejected',
            reason: 'invalid payload',
            reviewedAt: serverNow,
          });
          return null;
        }

        // Apply as a new ADMIN_EDIT record
        const newRec = {
          ...p,
          sessionId: op.sessionId,
          source: 'ADMIN_EDIT',
          editedBy: op.requestedBy || user?.email || 'unknown',
          serverTimestamp: serverNow,
        };
        await db.ref('attendance').push(newRec);

        await snap.ref.update({ status: 'applied', reviewedAt: serverNow });
        return null;
      }

      // Unknown op type
      await snap.ref.update({
        status: 'ignored',
        reason: 'unknown type',
        reviewedAt: serverNow,
      });
      return null;
    } catch (e) {
      await snap.ref.update({
        status: 'error',
        reason: String(e && e.message ? e.message : e),
        reviewedAt: serverNow,
      });
      return null;
    }
  });

/**
 * (Pilihan) Helper: set admin claim — JANGAN export sebagai function production.
 * Jalankan sekali dari REPL/admin skrip untuk menetapkan admin.
 *
 * Contoh guna (manual script di luar Cloud Functions):
 *   await admin.auth().setCustomUserClaims('<UID_ADMIN>', { admin: true });
 */
