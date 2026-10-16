// utils/surveySwitch.js
/**
 * On/off switch for the research questionnaires (Student Residents + Dormitory Manager).
 *
 * One flag, stored in app_settings so it survives restarts and is shared by every
 * instance reading the same DB:
 *   research_survey_enabled   '1' = ON (default when the key is missing), '0' = OFF
 *
 * When OFF
 *   • residents: feed card is not rendered, questionnaire + submit endpoints answer 403
 *   • admin:     the dashboard "Dormitory Manager" card is hidden, manager submit answers 403
 * Already-collected responses are NEVER touched, and the admin Research tab (results,
 * exports, and this switch itself) stays available so it can be turned back on.
 *
 * Missing key = ON on purpose, so deploying this change does not alter current behaviour.
 */

'use strict';

const { getSetting, setSetting } = require('./db');
const log = require('./logger');

const KEY_ENABLED    = 'research_survey_enabled';
const KEY_UPDATED_AT = 'research_survey_updated_at';
const KEY_UPDATED_BY = 'research_survey_updated_by';

function isEnabled() {
  return getSetting(KEY_ENABLED, '1') !== '0';
}

function getState() {
  return {
    enabled:   isEnabled(),
    updatedAt: getSetting(KEY_UPDATED_AT, '') || null,
    updatedBy: getSetting(KEY_UPDATED_BY, '') || null,
  };
}

/** @param {boolean} enabled  @param {string} [byUsername] for the audit trail */
function setEnabled(enabled, byUsername = '') {
  setSetting(KEY_ENABLED,    enabled ? '1' : '0');
  setSetting(KEY_UPDATED_AT, new Date().toISOString());
  setSetting(KEY_UPDATED_BY, byUsername);
  log.info(`[Research] Survey switched ${enabled ? 'ON' : 'OFF'} by @${byUsername || '?'}`);
  return getState();
}

/** Uniform "closed" reply. `disabled: true` lets the clients hide their UI instead of showing an error. */
function sendDisabled(res) {
  return res.status(403).json({ error: 'The survey is currently closed.', disabled: true });
}

module.exports = { isEnabled, getState, setEnabled, sendDisabled };
