import { useCallback, useEffect, useMemo, useState } from "react";
import Nav from "../components/Nav.jsx";
import { useApiFetch } from "../hooks/useApiFetch.js";
import usePageMeta from "../hooks/usePageMeta.js";
import "./PhytoPage.css";

const PRODUCT_CATEGORIES = [
  "Herbicide",
  "Fongicide",
  "Insecticide",
  "Adjuvant",
  "Biostimulant",
  "Engrais foliaire",
  "Autre",
];

const PRODUCT_UNITS = ["L", "kg", "g", "ml"];

function fmtDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("fr-FR");
}

function categoryClass(category) {
  return `pp-badge pp-badge-${String(category || "autre")
    .toLowerCase()
    .replaceAll(" ", "-")}`;
}

function Modal({ title, onClose, children }) {
  return (
    <div className="pp-overlay" onClick={onClose}>
      <div className="pp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pp-modal-header">
          <span>{title}</span>
          <button className="pp-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="pp-modal-body">{children}</div>
      </div>
    </div>
  );
}

function ProductForm({ initial, onSubmit, onCancel }) {
  const [form, setForm] = useState({
    name: initial?.name || "",
    category: initial?.category || PRODUCT_CATEGORIES[0],
    stock: initial?.stock ?? "",
    unit: initial?.unit || PRODUCT_UNITS[0],
    notes: initial?.notes || "",
  });

  const set = (key) => (e) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  return (
    <form
      className="pp-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(form);
      }}
    >
      <div className="pp-form-row">
        <label>Nom du produit *</label>
        <input
          required
          value={form.name}
          onChange={set("name")}
          placeholder="ex: Atlantis WG"
        />
      </div>
      <div className="pp-form-row2">
        <div className="pp-form-row">
          <label>Catégorie</label>
          <select value={form.category} onChange={set("category")}>
            {PRODUCT_CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="pp-form-row">
          <label>Unité</label>
          <select value={form.unit} onChange={set("unit")}>
            {PRODUCT_UNITS.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="pp-form-row2">
        <div className="pp-form-row">
          <label>Stock</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={form.stock}
            onChange={set("stock")}
            placeholder="0"
          />
        </div>
      </div>
      <div className="pp-form-row">
        <label>Notes</label>
        <textarea
          rows={3}
          value={form.notes}
          onChange={set("notes")}
          placeholder="Observations, cultures concernées, précautions..."
        />
      </div>
      <div className="pp-form-actions">
        <button
          type="button"
          className="pp-btn pp-btn-ghost"
          onClick={onCancel}
        >
          Annuler
        </button>
        <button type="submit" className="pp-btn pp-btn-primary">
          Enregistrer
        </button>
      </div>
    </form>
  );
}

function ApplicationForm({ initial, products, onSubmit, onCancel, onAlert }) {
  const [date, setDate] = useState(
    initial?.date
      ? initial.date.split("T")[0]
      : new Date().toISOString().split("T")[0],
  );
  const [notes, setNotes] = useState(initial?.notes || "");
  const [selectedProducts, setSelectedProducts] = useState(
    initial?.products?.filter((p) => p && p.product_id) || [],
  );
  const [errors, setErrors] = useState({});

  const addProduct = () => {
    if (products.length > 0) {
      setSelectedProducts([
        ...selectedProducts,
        { product_id: products[0].id, quantity_used: "" },
      ]);
      setErrors({});
    }
  };

  const removeProduct = (index) => {
    setSelectedProducts(selectedProducts.filter((_, i) => i !== index));
    setErrors({});
  };

  const updateProduct = (index, field, value) => {
    const updated = [...selectedProducts];
    updated[index] = { ...updated[index], [field]: value };
    setSelectedProducts(updated);
    setErrors({});
  };

  const validateProducts = () => {
    const newErrors = {};
    selectedProducts.forEach((sp, idx) => {
      if (!sp.quantity_used) return;
      const product = products.find(
        (p) => String(p.id) === String(sp.product_id),
      );
      const quantity = Number(sp.quantity_used);
      const availableStock = Number(product?.stock || 0);
      if (quantity > availableStock) {
        newErrors[idx] =
          `Stock insuffisant pour ${product?.name}. Disponible: ${availableStock} ${product?.unit}`;
      }
    });
    return newErrors;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (selectedProducts.length === 0) {
      onAlert?.({
        type: "error",
        title: "Produits requis",
        message: "Ajoute au moins un produit",
        onClose: () => {},
      });
      return;
    }
    const validationErrors = validateProducts();
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    onSubmit({
      date,
      notes,
      products: selectedProducts.map((p) => ({
        product_id: Number(p.product_id),
        quantity_used: p.quantity_used ? Number(p.quantity_used) : null,
      })),
    });
  };

  return (
    <form className="pp-form" onSubmit={handleSubmit}>
      <div className="pp-form-row">
        <label>Date *</label>
        <input
          required
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>

      <div className="pp-form-row">
        <label>Produits et doses *</label>
        <div
          style={{
            border: "1px solid #ccc",
            padding: "10px",
            borderRadius: "4px",
            marginBottom: "10px",
          }}
        >
          {selectedProducts.length === 0 ? (
            <div style={{ color: "#999" }}>Aucun produit sélectionné</div>
          ) : (
            selectedProducts.map((sp, idx) => {
              const product = products.find(
                (p) => String(p.id) === String(sp.product_id),
              );
              const hasError = errors[idx];
              return (
                <div
                  key={idx}
                  style={{
                    marginBottom:
                      idx === selectedProducts.length - 1 ? "0" : "8px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: "8px",
                      alignItems: "flex-start",
                      flexWrap: "wrap",
                      borderBottom: hasError ? "2px solid #ff4444" : "none",
                      paddingBottom: hasError ? "8px" : "0",
                    }}
                  >
                    <select
                      value={sp.product_id}
                      onChange={(e) =>
                        updateProduct(idx, "product_id", e.target.value)
                      }
                      style={{ flex: "1 1 auto", minWidth: "150px" }}
                    >
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      placeholder={`Qté (${product?.unit || "unit"})`}
                      min={0}
                      step="0.1"
                      value={sp.quantity_used}
                      onChange={(e) =>
                        updateProduct(idx, "quantity_used", e.target.value)
                      }
                      style={{
                        flex: "0 1 120px",
                        borderColor: hasError ? "#ff4444" : "inherit",
                        boxShadow: hasError
                          ? "0 0 0 2px rgba(255,68,68,0.1)"
                          : "none",
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => removeProduct(idx)}
                      style={{
                        padding: "8px 12px",
                        background: "#ff4444",
                        color: "white",
                        border: "none",
                        borderRadius: "4px",
                        cursor: "pointer",
                        flexShrink: 0,
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  {hasError && (
                    <div
                      style={{
                        color: "#ff4444",
                        fontSize: "12px",
                        marginTop: "4px",
                        fontWeight: "500",
                      }}
                    >
                      {hasError}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
        <button
          type="button"
          className="pp-btn pp-btn-ghost"
          onClick={addProduct}
          disabled={products.length === 0}
          style={{ marginTop: "8px" }}
        >
          + Ajouter un produit
        </button>
      </div>

      <div className="pp-form-row">
        <label>Notes</label>
        <textarea
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes sur l'intervention..."
        />
      </div>

      <div className="pp-form-actions">
        <button
          type="button"
          className="pp-btn pp-btn-ghost"
          onClick={onCancel}
        >
          Annuler
        </button>
        <button type="submit" className="pp-btn pp-btn-primary">
          Enregistrer
        </button>
      </div>
    </form>
  );
}

export default function PhytoPage() {
  const apiFetch = useApiFetch();

  const [products, setProducts] = useState([]);
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [searchProducts, setSearchProducts] = useState("");
  const [searchApplications, setSearchApplications] = useState("");
  const [deleteContext, setDeleteContext] = useState(null);
  const [sortProductsBy, setSortProductsBy] = useState("name");
  const [filterApplicationsYear, setFilterApplicationsYear] = useState("");
  const [alertContext, setAlertContext] = useState(null);
  const [exporting, setExporting] = useState(false);

  usePageMeta("Phyto", "/assets/icons8-champ-32.png");

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [productsData, applicationsData] = await Promise.all([
        apiFetch("/api/phyto/products"),
        apiFetch("/api/phyto/applications"),
      ]);
      setProducts(productsData);
      const normalizedApplications = (applicationsData || []).map((app) => ({
        ...app,
        products: Array.isArray(app.products)
          ? app.products
          : typeof app.products === "string"
            ? JSON.parse(app.products)
            : [],
      }));
      setApplications(normalizedApplications);
    } catch (error) {
      console.error("Erreur chargement phyto:", error);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const stats = useMemo(() => {
    const lowStockCount = products.filter(
      (p) => Number(p.stock || 0) > 0 && Number(p.stock || 0) <= 5,
    ).length;
    return { lowStockCount };
  }, [products]);

  // ─── CRUD produits ───────────────────────────────────────────

  const createProduct = async (payload) => {
    await apiFetch("/api/phyto/products", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setModal(null);
    await loadData();
  };

  const updateProduct = async (payload) => {
    await apiFetch(`/api/phyto/products/${editTarget.id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    setModal(null);
    setEditTarget(null);
    await loadData();
  };

  const deleteProduct = async (product) => {
    setAlertContext({
      type: "confirm",
      title: "Supprimer le produit",
      message: `Supprimer le produit "${product.name}" et ses interventions associées ?`,
      onConfirm: async () => {
        await apiFetch(`/api/phyto/products/${product.id}`, {
          method: "DELETE",
        });
        await loadData();
        setAlertContext(null);
      },
      onCancel: () => setAlertContext(null),
    });
  };

  // ─── CRUD applications ───────────────────────────────────────

  const createApplication = async (payload) => {
    try {
      await apiFetch("/api/phyto/applications", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setModal(null);
      await loadData();
    } catch (error) {
      setAlertContext({
        type: "error",
        title: "Erreur",
        message:
          error.message || "Erreur lors de la création de l'intervention",
        onClose: () => setAlertContext(null),
      });
    }
  };

  const updateApplication = async (payload) => {
    try {
      await apiFetch(`/api/phyto/applications/${editTarget.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setModal(null);
      setEditTarget(null);
      await loadData();
    } catch (error) {
      setAlertContext({
        type: "error",
        title: "Erreur",
        message:
          error.message || "Erreur lors de la mise à jour de l'intervention",
        onClose: () => setAlertContext(null),
      });
    }
  };

  const deleteApplication = async (application) => {
    setDeleteContext({
      id: application.id,
      date: application.date,
      pending: true,
    });
  };

  const confirmDeleteApplication = async (restoreStock) => {
    const { id } = deleteContext;
    try {
      await apiFetch(
        `/api/phyto/applications/${id}?restoreStock=${restoreStock}`,
        {
          method: "DELETE",
        },
      );
      setDeleteContext(null);
      await loadData();
    } catch (error) {
      setAlertContext({
        type: "error",
        title: "Erreur",
        message: error.message || "Erreur lors de la suppression",
        onClose: () => {
          setAlertContext(null);
          setDeleteContext(null);
        },
      });
    }
  };

  // ─── Export CSV ──────────────────────────────────────────────

  const handleExportCsv = async () => {
    setExporting(true);
    try {
      const res = await fetch("/api/phyto/export", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // Nom de fichier avec la date du jour
      const today = new Date().toISOString().split("T")[0];
      a.download = `phyto_interventions_${today}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      setAlertContext({
        type: "error",
        title: "Erreur export",
        message: "Impossible de générer le fichier CSV.",
        onClose: () => setAlertContext(null),
      });
    } finally {
      setExporting(false);
    }
  };

  const handleExportProductsCsv = async () => {
    setExporting(true);
    try {
      const res = await fetch("/api/phyto/products/export", {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const today = new Date().toISOString().split("T")[0];
      a.download = `phyto_produits_${today}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      setAlertContext({
        type: "error",
        title: "Erreur export",
        message: "Impossible de générer le fichier CSV.",
        onClose: () => setAlertContext(null),
      });
    } finally {
      setExporting(false);
    }
  };

  // ─── Filtres / tri ───────────────────────────────────────────

  const filteredProducts = useMemo(() => {
    let filtered = products;
    if (searchProducts.trim()) {
      const query = searchProducts.toLowerCase();
      filtered = filtered.filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          p.category.toLowerCase().includes(query),
      );
    }
    const sorted = [...filtered];
    if (sortProductsBy === "category") {
      sorted.sort((a, b) => {
        const catA = (a.category || "").toLowerCase();
        const catB = (b.category || "").toLowerCase();
        if (catA !== catB) return catA.localeCompare(catB);
        return (a.name || "").localeCompare(b.name || "");
      });
    } else {
      sorted.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    }
    return sorted;
  }, [products, searchProducts, sortProductsBy]);

  const availableYears = useMemo(() => {
    const years = new Set(
      applications.map((app) => new Date(app.date).getFullYear()),
    );
    return Array.from(years).sort((a, b) => b - a);
  }, [applications]);

  const filteredApplications = useMemo(() => {
    let filtered = applications;
    if (searchApplications.trim()) {
      const query = searchApplications.toLowerCase();
      filtered = filtered.filter((app) => {
        const dateStr = fmtDate(app.date).toLowerCase();
        const productNames = app.products
          ?.map((p) => p.product_name?.toLowerCase() || "")
          .join(" ");
        const notes = app.notes?.toLowerCase() || "";
        return (
          dateStr.includes(query) ||
          productNames.includes(query) ||
          notes.includes(query)
        );
      });
    }
    if (filterApplicationsYear) {
      filtered = filtered.filter(
        (app) =>
          new Date(app.date).getFullYear() === Number(filterApplicationsYear),
      );
    }
    return [...filtered].sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [applications, searchApplications, filterApplicationsYear]);

  // ─── Render ──────────────────────────────────────────────────

  return (
    <>
      <Nav />
      <div className="pp-page">
        <div className="pp-summary-grid">
          <div className="pp-summary-card">
            <span className="pp-summary-label">Produits</span>
            <strong>{products.length}</strong>
          </div>
          <div className="pp-summary-card">
            <span className="pp-summary-label">Alertes stock</span>
            <strong>{stats.lowStockCount}</strong>
          </div>
        </div>

        <div className="pp-layout">
          {/* ── Produits ── */}
          <section className="pp-panel pp-panel-left">
            <div className="pp-panel-header">
              <div>
                <h2>Produits phyto</h2>
                <span className="pp-panel-subtitle">Stock et notes</span>
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                {!loading && products.length > 0 && (
                  <button
                    className="pp-btn pp-btn-ghost"
                    onClick={handleExportProductsCsv}
                    disabled={exporting}
                    title="Exporter en CSV"
                  >
                    {exporting ? "Export…" : "⬇ CSV"}
                  </button>
                )}
                <button
                  className="pp-btn pp-btn-primary"
                  onClick={() => setModal("add-product")}
                >
                  + Produit
                </button>
              </div>
            </div>

            {!loading && products.length > 0 && (
              <div
                style={{
                  padding: "10px",
                  marginBottom: "10px",
                  display: "flex",
                  gap: "8px",
                }}
              >
                <input
                  type="text"
                  placeholder="Chercher un produit..."
                  value={searchProducts}
                  onChange={(e) => setSearchProducts(e.target.value)}
                  style={{
                    flex: 1,
                    padding: "8px",
                    border: "1px solid #ccc",
                    borderRadius: "4px",
                    fontSize: "14px",
                    boxSizing: "border-box",
                  }}
                />
                <select
                  value={sortProductsBy}
                  onChange={(e) => setSortProductsBy(e.target.value)}
                  style={{
                    padding: "8px",
                    border: "1px solid #ccc",
                    borderRadius: "4px",
                    fontSize: "14px",
                    backgroundColor: "white",
                    cursor: "pointer",
                  }}
                >
                  <option value="name">Trier: Nom</option>
                  <option value="category">Trier: Catégorie</option>
                </select>
              </div>
            )}

            {loading ? (
              <div className="pp-empty">Chargement…</div>
            ) : products.length === 0 ? (
              <div className="pp-empty">Aucun produit enregistré.</div>
            ) : filteredProducts.length === 0 ? (
              <div className="pp-empty">
                Aucun produit ne correspond à la recherche.
              </div>
            ) : (
              <div className="pp-product-list">
                {filteredProducts.map((product) => {
                  const lowStock =
                    Number(product.stock || 0) > 0 &&
                    Number(product.stock || 0) <= 5;
                  return (
                    <article key={product.id} className="pp-product-card">
                      <div className="pp-product-card-top">
                        <div>
                          <div className="pp-product-name">{product.name}</div>
                          <div className="pp-product-meta-row">
                            <span className={categoryClass(product.category)}>
                              {product.category}
                            </span>
                          </div>
                        </div>
                        <div
                          className="pp-card-actions"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            className="pp-icon-btn"
                            onClick={() => {
                              setEditTarget(product);
                              setModal("edit-product");
                            }}
                            title="Modifier"
                          >
                            ✏️
                          </button>
                          <button
                            className="pp-icon-btn pp-icon-btn-danger"
                            onClick={() => deleteProduct(product)}
                            title="Supprimer"
                          >
                            🗑️
                          </button>
                        </div>
                      </div>
                      <div className="pp-product-meta-row">
                        <span>
                          Stock: {product.stock || 0} {product.unit || ""}
                        </span>
                      </div>
                      {lowStock && (
                        <div className="pp-alert pp-alert-warning">
                          Stock bas
                        </div>
                      )}
                      {product.notes && (
                        <div className="pp-notes">{product.notes}</div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          {/* ── Interventions ── */}
          <section className="pp-panel pp-panel-right">
            <div className="pp-panel-header">
              <div>
                <h2>Interventions</h2>
                <span className="pp-panel-subtitle">
                  Historique de tous les traitements
                </span>
              </div>
              <div className="pp-header-actions">
                {/* ✅ Bouton export CSV */}
                {applications.length > 0 && (
                  <button
                    className="pp-btn pp-btn-ghost"
                    onClick={handleExportCsv}
                    disabled={exporting}
                    title="Exporter en CSV"
                  >
                    {exporting ? "Export…" : "⬇ CSV"}
                  </button>
                )}
                <button
                  className="pp-btn pp-btn-primary"
                  onClick={() => setModal("add-application")}
                  disabled={products.length === 0}
                >
                  + Intervention
                </button>
              </div>
            </div>

            {!loading && applications.length > 0 && (
              <div
                style={{
                  padding: "10px",
                  marginBottom: "10px",
                  display: "flex",
                  gap: "8px",
                }}
              >
                <input
                  type="text"
                  placeholder="Chercher une intervention..."
                  value={searchApplications}
                  onChange={(e) => setSearchApplications(e.target.value)}
                  style={{
                    flex: 1,
                    padding: "8px",
                    border: "1px solid #ccc",
                    borderRadius: "4px",
                    fontSize: "14px",
                    boxSizing: "border-box",
                  }}
                />
                <select
                  value={filterApplicationsYear}
                  onChange={(e) => setFilterApplicationsYear(e.target.value)}
                  style={{
                    padding: "8px",
                    border: "1px solid #ccc",
                    borderRadius: "4px",
                    fontSize: "14px",
                    backgroundColor: "white",
                    cursor: "pointer",
                  }}
                >
                  <option value="">Toutes les années</option>
                  {availableYears.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {products.length === 0 ? (
              <div className="pp-empty pp-empty-center">
                Ajoute d'abord un produit pour enregistrer une intervention.
              </div>
            ) : loading ? (
              <div className="pp-empty">Chargement…</div>
            ) : applications.length === 0 ? (
              <div className="pp-empty pp-empty-center">
                Aucune intervention enregistrée.
              </div>
            ) : filteredApplications.length === 0 ? (
              <div className="pp-empty pp-empty-center">
                Aucune intervention ne correspond à la recherche.
              </div>
            ) : (
              <div className="pp-application-list">
                {filteredApplications.map((application) => (
                  <article key={application.id} className="pp-application-card">
                    <div className="pp-application-top">
                      <div>
                        <div className="pp-application-title">
                          {fmtDate(application.date)}
                        </div>
                        <div className="pp-product-meta-row">
                          {application.products
                            ?.filter((p) => p && p.product_id)
                            .map((p, idx) => (
                              <span
                                key={idx}
                                className="pp-badge pp-badge-neutral"
                              >
                                {p.product_name || "Produit supprimé"}
                              </span>
                            ))}
                        </div>
                      </div>
                      <div className="pp-card-actions">
                        <button
                          className="pp-icon-btn"
                          onClick={() => {
                            setEditTarget(application);
                            setModal("edit-application");
                          }}
                          title="Modifier"
                        >
                          ✏️
                        </button>
                        <button
                          className="pp-icon-btn pp-icon-btn-danger"
                          onClick={() => deleteApplication(application)}
                          title="Supprimer"
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                    {application.products
                      ?.filter((p) => p && p.product_id)
                      .map((p, idx) => (
                        <div key={idx} className="pp-product-meta-row">
                          <span>{p.product_name}</span>
                          {p.quantity_used != null && (
                            <span style={{ color: "#888", fontSize: 12 }}>
                              — {p.quantity_used}{" "}
                              {products.find((pr) => pr.id === p.product_id)
                                ?.unit || ""}
                            </span>
                          )}
                        </div>
                      ))}
                    {application.notes ? (
                      <div className="pp-notes">{application.notes}</div>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* ── Modals ── */}
      {deleteContext?.pending && (
        <Modal
          title="Supprimer l'intervention"
          onClose={() => setDeleteContext(null)}
        >
          <div style={{ padding: "20px" }}>
            <p style={{ marginBottom: "20px", fontSize: "14px" }}>
              Voulez-vous rétablir le stock des produits utilisés dans
              l'intervention du <strong>{fmtDate(deleteContext.date)}</strong> ?
            </p>
            <div
              style={{
                display: "flex",
                gap: "10px",
                justifyContent: "flex-end",
              }}
            >
              <button
                className="pp-btn pp-btn-ghost"
                onClick={() => setDeleteContext(null)}
              >
                Annuler
              </button>
              <button
                className="pp-btn pp-btn-ghost"
                style={{ color: "#ff9800" }}
                onClick={() => confirmDeleteApplication(false)}
              >
                Non, garder la déduction
              </button>
              <button
                className="pp-btn pp-btn-primary"
                onClick={() => confirmDeleteApplication(true)}
              >
                Oui, rétablir le stock
              </button>
            </div>
          </div>
        </Modal>
      )}

      {modal === "add-product" && (
        <Modal title="Ajouter un produit phyto" onClose={() => setModal(null)}>
          <ProductForm
            onSubmit={createProduct}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}

      {modal === "edit-product" && editTarget && (
        <Modal title="Modifier le produit" onClose={() => setModal(null)}>
          <ProductForm
            initial={editTarget}
            onSubmit={updateProduct}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}

      {modal === "add-application" && (
        <Modal title="Ajouter une intervention" onClose={() => setModal(null)}>
          <ApplicationForm
            products={products}
            onSubmit={createApplication}
            onCancel={() => setModal(null)}
            onAlert={setAlertContext}
          />
        </Modal>
      )}

      {modal === "edit-application" && editTarget && (
        <Modal title="Modifier l'intervention" onClose={() => setModal(null)}>
          <ApplicationForm
            initial={editTarget}
            products={products}
            onSubmit={updateApplication}
            onCancel={() => setModal(null)}
            onAlert={setAlertContext}
          />
        </Modal>
      )}

      {alertContext?.type === "error" && (
        <Modal
          title={alertContext.title || "Erreur"}
          onClose={alertContext.onClose}
        >
          <div style={{ padding: "20px", textAlign: "center" }}>
            <p style={{ marginBottom: "20px", fontSize: "14px" }}>
              {alertContext.message}
            </p>
            <button
              className="pp-btn pp-btn-primary"
              onClick={alertContext.onClose}
            >
              Fermer
            </button>
          </div>
        </Modal>
      )}

      {alertContext?.type === "confirm" && (
        <Modal
          title={alertContext.title || "Confirmation"}
          onClose={alertContext.onCancel}
        >
          <div style={{ padding: "20px" }}>
            <p style={{ marginBottom: "20px", fontSize: "14px" }}>
              {alertContext.message}
            </p>
            <div
              style={{
                display: "flex",
                gap: "10px",
                justifyContent: "flex-end",
              }}
            >
              <button
                className="pp-btn pp-btn-ghost"
                onClick={alertContext.onCancel}
              >
                Annuler
              </button>
              <button
                className="pp-btn pp-btn-primary"
                onClick={alertContext.onConfirm}
              >
                Confirmer
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
