const express = require('express');
const db = require('../db');
const { sendSuccess, sendError } = require('../helpers/response');

const router = express.Router();

function userId(req) {
  return String(req.user?.id || '').trim();
}

router.get('/map-preferences', async (req, res) => {
  try {
    const uid = userId(req);
    if (!uid) return sendError(res, 'Authenticated user required', 401);
    const result = await db.query(
      'SELECT zone_radius_km, updated_at FROM user_map_preferences WHERE user_id = $1',
      [uid]
    );
    const row = result.rows[0];
    return sendSuccess(res, {
      zone_radius_km: row ? Number(row.zone_radius_km) : 30,
      updated_at: row?.updated_at || null,
    }, 'Map preferences retrieved');
  } catch (error) {
    return sendError(res, error.message, 500);
  }
});

router.put('/map-preferences', async (req, res) => {
  try {
    const uid = userId(req);
    if (!uid) return sendError(res, 'Authenticated user required', 401);
    const radius = Number(req.body?.zone_radius_km);
    if (!Number.isFinite(radius) || radius < 1 || radius > 100) {
      return sendError(res, 'zone_radius_km must be between 1 and 100', 400);
    }
    const result = await db.query(
      `INSERT INTO user_map_preferences (user_id, zone_radius_km, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         zone_radius_km = EXCLUDED.zone_radius_km,
         updated_at = NOW()
       RETURNING zone_radius_km, updated_at`,
      [uid, radius]
    );
    return sendSuccess(res, {
      zone_radius_km: Number(result.rows[0].zone_radius_km),
      updated_at: result.rows[0].updated_at,
    }, 'Map preferences updated');
  } catch (error) {
    return sendError(res, error.message, 500);
  }
});

module.exports = router;
