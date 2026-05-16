/**
 * attendance-api/src/routes/productRoutes.js
 *
 * Dedicated product routes — replaces the /ref/products endpoints in
 * referenceRoutes.js for the Products admin page. referenceRoutes.js
 * is NOT modified — its /ref/products endpoints remain available.
 *
 * Mount in server.js:
 *   import productRoutes from './routes/productRoutes.js';
 *   app.use('/api/products', productRoutes);
 *
 * Endpoints:
 *   GET    /api/products                  — list all with price + system + portfolio
 *   GET    /api/products/:id              — single product with full detail
 *   GET    /api/products/:id/prices       — price history (append-only log)
 *   POST   /api/products                  — create product
 *   PATCH  /api/products/:id              — update product
 *   DELETE /api/products/:id              — delete product
 *
 * No other files are modified by adding this route file.
 */

import { Router } from 'express';
import pool       from '../config/db.js';
import { io }     from '../server.js';
import logger     from '../logger.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/products
// Full list with system, portfolio, and current price joined.
// Used by Products.jsx table — replaces GET /ref/products.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        pr.id,
        pr.system_id,
        pr.manufacturer,
        pr.brand,
        pr.model,
        pr.description,
        pr.image_url,
        pr.source_url,
        pr.specs,
        pr.created_at,
        s.name        AS system_name,
        po.name       AS portfolio_name,
        po.id         AS portfolio_id,
        -- Current price from append-only view (latest row per product)
        pp.lowest_price,
        pp.average_price,
        pp.currency,
        pp.source          AS price_source,
        pp.source_notes    AS price_source_notes,
        pp.created_at      AS price_updated_at
      FROM products pr
      LEFT JOIN systems       s  ON pr.system_id    = s.id
      LEFT JOIN portfolios    po ON s.portfolio_id  = po.id
      LEFT JOIN product_price_current pp ON pp.product_id = pr.id
      ORDER BY pr.manufacturer ASC, pr.brand ASC, pr.model ASC
    `);
    res.json(result.rows);
  } catch (err) {
    logger.error(`Fetch products failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/products/:id
// Single product with full detail including specs and current price.
// Used by the detail drawer / modal in Products.jsx.
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        pr.id,
        pr.system_id,
        pr.manufacturer,
        pr.brand,
        pr.model,
        pr.description,
        pr.image_url,
        pr.source_url,
        pr.specs,
        pr.created_at,
        s.name        AS system_name,
        po.name       AS portfolio_name,
        po.id         AS portfolio_id,
        pp.lowest_price,
        pp.average_price,
        pp.currency,
        pp.source          AS price_source,
        pp.source_notes    AS price_source_notes,
        pp.created_at      AS price_updated_at
      FROM products pr
      LEFT JOIN systems       s  ON pr.system_id    = s.id
      LEFT JOIN portfolios    po ON s.portfolio_id  = po.id
      LEFT JOIN product_price_current pp ON pp.product_id = pr.id
      WHERE pr.id = $1
    `, [req.params.id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Product not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error(`Fetch product ${req.params.id} failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/products/:id/prices
// Full price history for a product — all rows from product_prices,
// newest first. Used for the price history chart in the detail drawer.
// ---------------------------------------------------------------------------
router.get('/:id/prices', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  try {
    const result = await pool.query(`
      SELECT
        id,
        lowest_price,
        average_price,
        currency,
        source,
        source_notes,
        fetched_by,
        created_at
      FROM product_prices
      WHERE product_id = $1
      ORDER BY id DESC
      LIMIT $2
    `, [req.params.id, limit]);

    res.json({
      product_id: parseInt(req.params.id, 10),
      count:      result.rows.length,
      prices:     result.rows,
    });
  } catch (err) {
    logger.error(`Fetch price history for product ${req.params.id} failed: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/products
// Create a new product. Handles all columns including the new ones
// added in migration_v16 (image_url, specs, source_url).
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const {
    system_id,
    manufacturer,
    brand,
    model,
    description,
    image_url,
    source_url,
    specs,          // object or null — stored as JSONB
  } = req.body;

  if (!manufacturer?.trim()) return res.status(400).json({ error: 'manufacturer is required.' });
  if (!model?.trim())        return res.status(400).json({ error: 'model is required.' });

  try {
    const result = await pool.query(
      `INSERT INTO products
         (system_id, manufacturer, brand, model, description, image_url, source_url, specs)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        system_id    || null,
        manufacturer.trim(),
        brand?.trim()       || null,
        model.trim(),
        description?.trim() || null,
        image_url?.trim()   || null,
        source_url?.trim()  || null,
        specs ? JSON.stringify(specs) : null,
      ]
    );

    io.emit('dashboard-update');
    logger.info(`Product created: ${manufacturer} ${model}`, {
      category: 'general',
      meta: { product_id: result.rows[0].id, manufacturer, model, system_id },
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error(`Product create failed: ${err.message}`, { category: 'database', meta: { manufacturer, model } });
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/products/:id
// Partial update — only updates fields that are present in the request body.
// Uses COALESCE so omitted fields keep their current value.
// Handles all columns including new v16 fields.
// ---------------------------------------------------------------------------
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const {
    system_id,
    manufacturer,
    brand,
    model,
    description,
    image_url,
    source_url,
    specs,
  } = req.body;

  try {
    // Build dynamic SET clause — only update what was sent
    const sets   = [];
    const params = [];

    const addField = (col, val, transform = v => v) => {
      if (val !== undefined) {
        params.push(transform(val));
        sets.push(`${col} = $${params.length}`);
      }
    };

    addField('system_id',    system_id);
    addField('manufacturer', manufacturer, v => v?.trim() || null);
    addField('brand',        brand,        v => v?.trim() || null);
    addField('model',        model,        v => v?.trim() || null);
    addField('description',  description,  v => v?.trim() || null);
    addField('image_url',    image_url,    v => v?.trim() || null);
    addField('source_url',   source_url,   v => v?.trim() || null);
    addField('specs',        specs,        v => v ? JSON.stringify(v) : null);

    if (!sets.length) return res.status(400).json({ error: 'No fields to update.' });

    params.push(id);
    const result = await pool.query(
      `UPDATE products SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Product not found.' });

    io.emit('dashboard-update');
    logger.info(`Product updated: id ${id}`, {
      category: 'general',
      meta: { product_id: id, fields: Object.keys(req.body) },
    });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error(`Product update failed for id ${id}: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/products/:id
// Hard delete. Cascades to product_prices (ON DELETE CASCADE in migration_v16).
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const check = await pool.query('SELECT manufacturer, model FROM products WHERE id = $1', [id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Product not found.' });

    const { manufacturer, model } = check.rows[0];
    await pool.query('DELETE FROM products WHERE id = $1', [id]);

    io.emit('dashboard-update');
    logger.warn(`Product deleted: ${manufacturer} ${model} (id ${id})`, {
      category: 'general',
      meta: { product_id: id, manufacturer, model },
    });
    res.json({ success: true });
  } catch (err) {
    logger.error(`Product delete failed for id ${id}: ${err.message}`, { category: 'database' });
    res.status(500).json({ error: err.message });
  }
});

export default router;