const express = require("express");
const { pool } = require("../config");
const { authMiddleware } = require("../middleware");

const router = express.Router();

//Phyto — Produits

router.get("/api/phyto/products", authMiddleware, async (req, res) => {
  try {
    const [results] = await pool.execute(
      "SELECT * FROM phyto_products ORDER BY name ASC",
    );
    res.json(results || []);
  } catch (err) {
    console.error("Error fetching products:", err);
    res
      .status(500)
      .json({ success: false, message: "Error fetching products" });
  }
});

router.post("/api/phyto/products", authMiddleware, async (req, res) => {
  const { name, category, stock, unit, notes } = req.body;
  if (!name) {
    return res
      .status(400)
      .json({ success: false, message: "Product name is required" });
  }
  try {
    const [result] = await pool.execute(
      "INSERT INTO phyto_products (name, category, stock, unit, notes) VALUES (?, ?, ?, ?, ?)",
      [name, category || "Autre", stock || 0, unit || "L", notes || ""],
    );
    res
      .status(201)
      .json({ success: true, id: result.insertId, message: "Product created" });
  } catch (err) {
    console.error("Error creating product:", err);
    res.status(500).json({ success: false, message: "Error creating product" });
  }
});

router.put("/api/phyto/products/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { name, category, stock, unit, notes } = req.body;
  if (!name) {
    return res
      .status(400)
      .json({ success: false, message: "Product name is required" });
  }
  try {
    await pool.execute(
      "UPDATE phyto_products SET name = ?, category = ?, stock = ?, unit = ?, notes = ? WHERE id = ?",
      [name, category || "Autre", stock || 0, unit || "L", notes || "", id],
    );
    res.json({ success: true, message: "Product updated" });
  } catch (err) {
    console.error("Error updating product:", err);
    res.status(500).json({ success: false, message: "Error updating product" });
  }
});

router.delete("/api/phyto/products/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.execute("DELETE FROM phyto_products WHERE id = ?", [id]);
    res.json({ success: true, message: "Product deleted" });
  } catch (err) {
    console.error("Error deleting product:", err);
    res.status(500).json({ success: false, message: "Error deleting product" });
  }
});

//Phyto — Applications

router.get("/api/phyto/applications", authMiddleware, async (req, res) => {
  try {
    const [results] = await pool.execute(
      `SELECT
        a.id, a.date, a.notes, a.created_at, a.updated_at,
        COALESCE(JSON_ARRAYAGG(
          CASE WHEN ap.id IS NOT NULL THEN JSON_OBJECT(
            'id', ap.id,
            'product_id', ap.product_id,
            'product_name', p.name,
            'quantity_used', ap.quantity_used
          ) END
        ), JSON_ARRAY()) as products
      FROM phyto_applications a
      LEFT JOIN phyto_application_products ap ON a.id = ap.application_id
      LEFT JOIN phyto_products p ON ap.product_id = p.id
      GROUP BY a.id
      ORDER BY a.date DESC`,
    );
    res.json(results || []);
  } catch (err) {
    console.error("Error fetching applications:", err);
    res
      .status(500)
      .json({ success: false, message: "Error fetching applications" });
  }
});

router.post("/api/phyto/applications", authMiddleware, async (req, res) => {
  const { date, notes, products } = req.body;

  if (!date || !Array.isArray(products) || products.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Date and at least one product are required",
    });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const productsWithQty = products.filter(
      (p) => p.quantity_used && Number(p.quantity_used) > 0,
    );
    if (productsWithQty.length > 0) {
      const productIds = productsWithQty.map((p) => p.product_id);
      const [existingProducts] = await conn.query(
        "SELECT id, name, stock, unit FROM phyto_products WHERE id IN (?)",
        [productIds],
      );

      for (const p of productsWithQty) {
        const existing = existingProducts.find((ep) => ep.id === p.product_id);
        if (!existing) {
          await conn.rollback();
          return res.status(400).json({
            success: false,
            message: `Produit ID ${p.product_id} introuvable`,
          });
        }
        if (Number(p.quantity_used) > Number(existing.stock || 0)) {
          await conn.rollback();
          return res.status(400).json({
            success: false,
            message: `Stock insuffisant pour ${existing.name}. Disponible : ${existing.stock} ${existing.unit}`,
          });
        }
      }
    }

    const [appResult] = await conn.execute(
      "INSERT INTO phyto_applications (date, notes) VALUES (?, ?)",
      [date, notes || ""],
    );
    const applicationId = appResult.insertId;

    if (products.length > 0) {
      const productInserts = products.map((p) => [
        applicationId,
        p.product_id,
        p.quantity_used || null,
      ]);
      await conn.query(
        "INSERT INTO phyto_application_products (application_id, product_id, quantity_used) VALUES ?",
        [productInserts],
      );
    }

    for (const p of productsWithQty) {
      await conn.execute(
        "UPDATE phyto_products SET stock = stock - ? WHERE id = ?",
        [Number(p.quantity_used), p.product_id],
      );
    }

    await conn.commit();
    res.status(201).json({
      success: true,
      id: applicationId,
      message: "Application created",
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error creating application:", err);
    res
      .status(500)
      .json({ success: false, message: "Error creating application" });
  } finally {
    conn.release();
  }
});

router.put("/api/phyto/applications/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { date, notes, products } = req.body;

  if (!date || !Array.isArray(products) || products.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Date and at least one product are required",
    });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [oldProducts] = await conn.execute(
      "SELECT product_id, quantity_used FROM phyto_application_products WHERE application_id = ?",
      [id],
    );

    for (const p of oldProducts.filter((p) => p.quantity_used)) {
      await conn.execute(
        "UPDATE phyto_products SET stock = stock + ? WHERE id = ?",
        [p.quantity_used, p.product_id],
      );
    }

    await conn.execute(
      "UPDATE phyto_applications SET date = ?, notes = ? WHERE id = ?",
      [date, notes || "", id],
    );

    await conn.execute(
      "DELETE FROM phyto_application_products WHERE application_id = ?",
      [id],
    );

    if (products.length > 0) {
      const productInserts = products.map((p) => [
        id,
        p.product_id,
        p.quantity_used || null,
      ]);
      await conn.query(
        "INSERT INTO phyto_application_products (application_id, product_id, quantity_used) VALUES ?",
        [productInserts],
      );
    }

    for (const p of products.filter((p) => p.quantity_used)) {
      await conn.execute(
        "UPDATE phyto_products SET stock = stock - ? WHERE id = ?",
        [Number(p.quantity_used), p.product_id],
      );
    }

    await conn.commit();
    res.json({ success: true, message: "Application updated" });
  } catch (err) {
    await conn.rollback();
    console.error("Error updating application:", err);
    res
      .status(500)
      .json({ success: false, message: "Error updating application" });
  } finally {
    conn.release();
  }
});

router.delete(
  "/api/phyto/applications/:id",
  authMiddleware,
  async (req, res) => {
    const { id } = req.params;
    const restoreStock = req.query.restoreStock === "true";

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      if (restoreStock) {
        const [products] = await conn.execute(
          "SELECT product_id, quantity_used FROM phyto_application_products WHERE application_id = ?",
          [id],
        );
        for (const p of products.filter((p) => p.quantity_used)) {
          await conn.execute(
            "UPDATE phyto_products SET stock = stock + ? WHERE id = ?",
            [p.quantity_used, p.product_id],
          );
        }
      }

      await conn.execute("DELETE FROM phyto_applications WHERE id = ?", [id]);

      await conn.commit();
      res.json({ success: true, message: "Application deleted" });
    } catch (err) {
      await conn.rollback();
      console.error("Error deleting application:", err);
      res
        .status(500)
        .json({ success: false, message: "Error deleting application" });
    } finally {
      conn.release();
    }
  },
);

//Phyto — Export CSV

router.get("/api/phyto/export", authMiddleware, async (req, res) => {
  try {
    const [applications] = await pool.execute(
      `SELECT
        a.id,
        a.date,
        a.notes,
        ap.quantity_used,
        p.name  AS product_name,
        p.unit  AS product_unit,
        p.category
      FROM phyto_applications a
      LEFT JOIN phyto_application_products ap ON a.id = ap.application_id
      LEFT JOIN phyto_products p ON ap.product_id = p.id
      ORDER BY a.date DESC, a.id, p.name`,
    );

    const BOM = "\uFEFF";
    const headers = [
      "Date",
      "Produit",
      "Catégorie",
      "Quantité",
      "Unité",
      "Notes",
    ];

    const rows = applications.map((row) => [
      row.date ? new Date(row.date).toLocaleDateString("fr-FR") : "",
      row.product_name || "",
      row.category || "",
      row.quantity_used != null
        ? String(row.quantity_used).replace(".", ",")
        : "",
      row.product_unit || "",
      row.notes ? `"${String(row.notes).replace(/"/g, '""')}"` : "",
    ]);

    const csvContent =
      BOM + [headers.join(";"), ...rows.map((r) => r.join(";"))].join("\r\n");

    const today = new Date().toISOString().split("T")[0];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="phyto_interventions_${today}.csv"`,
    );
    res.send(csvContent);
  } catch (err) {
    console.error("Erreur export CSV:", err);
    res
      .status(500)
      .json({ success: false, message: "Erreur lors de l'export" });
  }
});

router.get("/api/phyto/products/export", authMiddleware, async (req, res) => {
  try {
    const [products] = await pool.execute(
      "SELECT id, name, category, stock, unit, notes FROM phyto_products ORDER BY category ASC, name ASC",
    );

    const BOM = "\uFEFF";
    const headers = ["Produit", "Catégorie", "Stock", "Unité", "Notes"];

    const rows = products.map((row) => [
      row.name || "",
      row.category || "",
      String(row.stock || 0).replace(".", ","),
      row.unit || "",
      row.notes ? `"${String(row.notes).replace(/"/g, '""')}"` : "",
    ]);

    const csvContent =
      BOM + [headers.join(";"), ...rows.map((r) => r.join(";"))].join("\r\n");

    const today = new Date().toISOString().split("T")[0];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="phyto_produits_${today}.csv"`,
    );
    res.send(csvContent);
  } catch (err) {
    console.error("Erreur export CSV produits:", err);
    res
      .status(500)
      .json({ success: false, message: "Erreur lors de l'export" });
  }
});

module.exports = router;
