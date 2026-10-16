// utils/profileViews.js
/**
 * Profile-view tracking — who opened whose profile.
 *
 * Rules (all enforced here, so routes stay thin):
 *   • Self-views are ignored.
 *   • Views BY an admin/superadmin are ignored: not counted, no notification.
 *   • Views OF an admin account are ignored (the counter is for residents).
 *   • Counter throttle: the same viewer counts once per VIEW_THROTTLE_MINUTES per profile,
 *     so a page refresh cannot inflate the number.
 *   • Notification cooldown: the same viewer notifies the same resident at most once per
 *     NOTIFY_COOLDOWN_HOURS, so repeat visits cannot flood the notification list.
 *   • The notification names the viewer (unlike reputation votes, which stay anonymous).
 *     This is disclosed in the Terms & Conditions (section 5).
 *
 * Table is created here (same pattern as utils/researchSurvey.js); rows cascade away with
 * either user, and utils/schemaReconcile.js re-adds the table after a DB restore.
 */

'use strict';

const { db, genId, createNotification } = require('./db');
const log = require('./logger');

const VIEW_THROTTLE_MINUTES = 30;
const NOTIFY_COOLDOWN_HOURS = 24;

db.prepare(`CREATE TABLE IF NOT EXISTS profile_views (
  id         TEXT PRIMARY KEY,
  viewer_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_profile_views_target ON profile_views(target_id)`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_profile_views_pair   ON profile_views(target_id, viewer_id, created_at)`).run();

function isAdminRole(role) {
  return role === 'admin' || role === 'superadmin';
}

const skip = (reason) => ({ recorded: false, notified: false, reason });

/**
 * @param {{viewer: object, target: object}} args  user objects ({id, role, username, firstName})
 * @returns {{recorded: boolean, notified: boolean, reason?: string}}
 */
function recordView({ viewer, target }) {
  if (!viewer?.id || !target?.id)    return skip('invalid');
  if (viewer.id === target.id)       return skip('self');
  if (isAdminRole(viewer.role))      return skip('admin-viewer');
  if (isAdminRole(target.role))      return skip('admin-target');

  const recent = db.prepare(
    `SELECT 1 FROM profile_views
      WHERE viewer_id = ? AND target_id = ? AND created_at > datetime('now', ?)`
  ).get(viewer.id, target.id, `-${VIEW_THROTTLE_MINUTES} minutes`);
  if (recent) return skip('throttled');

  db.prepare('INSERT INTO profile_views (id, viewer_id, target_id) VALUES (?,?,?)')
    .run(genId(), viewer.id, target.id);

  let notified = false;
  try {
    const cooling = db.prepare(
      `SELECT 1 FROM notifications
        WHERE user_id = ? AND type = 'profile_view' AND actor_id = ? AND created_at > datetime('now', ?)`
    ).get(target.id, viewer.id, `-${NOTIFY_COOLDOWN_HOURS} hours`);

    if (!cooling) {
      createNotification({
        userId:   target.id,
        type:     'profile_view',
        actorId:  viewer.id,
        targetId: viewer.id,
        message:  `${viewer.firstName || 'Someone'} viewed your profile`,
      });
      notified = true;
    }
  } catch (err) {
    // The view itself is already stored — a notification failure must not undo or hide it.
    log.error(`[ProfileView] notification failed @${viewer.username} → @${target.username}: ${err.message}`);
  }

  log.info(`[ProfileView] @${viewer.username} → @${target.username} (counted${notified ? ', notified' : ', notification on cooldown'})`);
  return { recorded: true, notified };
}

/** @returns {{total: number, unique: number}} total counted views, and distinct residents who viewed */
function getStats(targetId) {
  const row = db.prepare(
    `SELECT COUNT(*) AS total, COUNT(DISTINCT viewer_id) AS uniqueViewers
       FROM profile_views WHERE target_id = ?`
  ).get(targetId);
  return { total: row.total || 0, unique: row.uniqueViewers || 0 };
}

module.exports = { recordView, getStats, isAdminRole, VIEW_THROTTLE_MINUTES, NOTIFY_COOLDOWN_HOURS };
