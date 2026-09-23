const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/monitoring/containers?server_id=... — dashboard read, all servers by default
router.get('/', async (req, res) => {
  const conditions = [];
  const values = [];
  if (req.query.server_id) { values.push(req.query.server_id); conditions.push(`c.server_id = $${values.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT c.*, s.name AS server_name
     FROM containers c JOIN servers s ON s.id = c.server_id
     ${where}
     ORDER BY s.name, c.name`,
    values
  );
  res.json(rows);
});

module.exports = router;
