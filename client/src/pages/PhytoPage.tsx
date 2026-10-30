import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import Nav from "../components/Nav";
import { useApiFetch } from "../hooks/useApiFetch";
import usePageMeta from "../hooks/usePageMeta";
import type {
  Application,
  ApplicationPayload,
  ApplicationProduct,
  Product,
  ProductPayload,
  RawApplication,
} from "../types/api";
import "./PhytoPage.css";

type ModalState =
  | { kind: "add-product" }
  | { kind: "edit-product"; product: Product }
  | { kind: "add-application" }
  | { kind: "edit-application"; application: Application };

type AlertState =
  | { type: "error"; title: string; message: string; onClose: () => void }
  | {
      type: "confirm";
      title: string;
      message: string;
      onConfirm: () => void;
      onCancel: () => void;
    };

interface DeleteContext {
  id: number;
  date: string;
  pending: boolean;
}

// Ligne en cours de saisie : les champs du formulaire renvoient des chaînes.
interface SelectedProduct {
  product_id: number | string;
  quantity_used: number | string | null;
}

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

function fmtDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("fr-FR");
}

// Minuscules sans accents ; tolère les valeurs nulles venant de la base.
function normalizeSearch(value: string | null) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function categoryClass(category: string | null) {
  return `pp-badge pp-badge-${String(category || "autre")
    .toLowerCase()
    .replaceAll(" ", "-")}`;
}

function hasProduct(
  product: ApplicationProduct | null,
): product is ApplicationProduct {
  return Boolean(product?.product_id);
}

function errorMessage(error: unknown, fallback: string) {
  return (error instanceof Error && error.message) || fallback;
}

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

function Modal({ title, onClose, children }: ModalProps) {
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

interface ProductFormProps {
  initial?: Product;
  onSubmit: (payload: ProductPayload) => void;
  onCancel: () => void;
}

function ProductForm({ initial, onSubmit, onCancel }: ProductFormProps) {
  const [form, setForm] = useState<ProductPayload>({
    name: initial?.name || "",
    category: initial?.category || PRODUCT_CATEGORIES[0],
    stock: initial?.stock ?? "",
    unit: initial?.unit || PRODUCT_UNITS[0],
    notes: initial?.notes || "",
  });

  const set =
    (key: keyof ProductPayload) =>
    (
      e: ChangeEvent<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >,
    ) =>
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

interface ApplicationFormProps {
  initial?: Application;
  products: Product[];
  onSubmit: (payload: ApplicationPayload) => void;
  onCancel: () => void;
  onAlert: (title: string, message: string) => void;
}

function ApplicationForm({
  initial,
  products,
  onSubmit,
  onCancel,
  onAlert,
}: ApplicationFormProps) {
  const [date, setDate] = useState(
    initial?.date
      ? initial.date.split("T")[0]
      : new Date().toISOString().split("T")[0],
  );
  const [notes, setNotes] = useState(initial?.notes || "");
  const [selectedProducts, setSelectedProducts] = useState<SelectedProduct[]>(
    initial?.products.filter(hasProduct) ?? [],
  );
  const [errors, setErrors] = useState<Record<number, string>>({});

  const addProduct = () => {
    if (products.length > 0) {
      setSelectedProducts([
        ...selectedProducts,
        { product_id: products[0].id, quantity_used: "" },
      ]);
      setErrors({});
    }
  };

  const removeProduct = (index: number) => {
    setSelectedProducts(selectedProducts.filter((_, i) => i !== index));
    setErrors({});
  };

  const updateProduct = (
    index: number,
    field: keyof SelectedProduct,
    value: string,
  ) => {
    const updated = [...selectedProducts];
    updated[index] = { ...updated[index], [field]: value };
    setSelectedProducts(updated);
    setErrors({});
  };

  const validateProducts = () => {
    const newErrors: Record<number, string> = {};
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

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (selectedProducts.length === 0) {
      onAlert("Produits requis", "Ajoute au moins un produit");
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
        <div className="pp-product-picker">
          {selectedProducts.length === 0 ? (
            <div className="pp-muted">Aucun produit sélectionné</div>
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
                    className={`pp-product-row ${hasError ? "pp-product-row-error" : ""}`}
                  >
                    <select
                      value={sp.product_id}
                      onChange={(e) =>
                        updateProduct(idx, "product_id", e.target.value)
                      }
                      className="pp-product-select"
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
                      value={sp.quantity_used ?? ""}
                      onChange={(e) =>
                        updateProduct(idx, "quantity_used", e.target.value)
                      }
                      className="pp-quantity-input"
                    />
                    <button
                      type="button"
                      className="pp-remove-btn"
                      onClick={() => removeProduct(idx)}
                      aria-label="Retirer le produit"
                    >
                      ✕
                    </button>
                  </div>
                  {hasError && <div className="pp-field-error">{hasError}</div>}
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

  const [products, setProducts] = useState<Product[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [searchProducts, setSearchProducts] = useState("");
  const [searchApplications, setSearchApplications] = useState("");
  const [deleteContext, setDeleteContext] = useState<DeleteContext | null>(
    null,
  );
  const [sortProductsBy, setSortProductsBy] = useState("name");
  const [filterApplicationsYear, setFilterApplicationsYear] = useState("");
  const [alertContext, setAlertContext] = useState<AlertState | null>(null);
  const [exporting, setExporting] = useState(false);

  usePageMeta("Phyto", "/assets/icons8-champ-32.png");

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [productsData, applicationsData] = await Promise.all([
        apiFetch<Product[]>("/api/phyto/products"),
        apiFetch<RawApplication[]>("/api/phyto/applications"),
      ]);
      setProducts(productsData);
      const normalizedApplications = (applicationsData || []).map(
        (app): Application => ({
          ...app,
          products: Array.isArray(app.products)
            ? app.products
            : typeof app.products === "string"
              ? JSON.parse(app.products)
              : [],
        }),
      );
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

  const showError = (title: string, message: string) => {
    setAlertContext({
      type: "error",
      title,
      message,
      onClose: () => setAlertContext(null),
    });
  };

  // ─── CRUD produits ───────────────────────────────────────────

  const createProduct = async (payload: ProductPayload) => {
    await apiFetch("/api/phyto/products", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setModal(null);
    await loadData();
  };

  const updateProduct = async (id: number, payload: ProductPayload) => {
    await apiFetch(`/api/phyto/products/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    setModal(null);
    await loadData();
  };

  const deleteProduct = async (product: Product) => {
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

  const createApplication = async (payload: ApplicationPayload) => {
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
        message: errorMessage(
          error,
          "Erreur lors de la création de l'intervention",
        ),
        onClose: () => setAlertContext(null),
      });
    }
  };

  const updateApplication = async (id: number, payload: ApplicationPayload) => {
    try {
      await apiFetch(`/api/phyto/applications/${id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setModal(null);
      await loadData();
    } catch (error) {
      setAlertContext({
        type: "error",
        title: "Erreur",
        message: errorMessage(
          error,
          "Erreur lors de la mise à jour de l'intervention",
        ),
        onClose: () => setAlertContext(null),
      });
    }
  };

  const deleteApplication = async (application: Application) => {
    setDeleteContext({
      id: application.id,
      date: application.date,
      pending: true,
    });
  };

  const confirmDeleteApplication = async (restoreStock: boolean) => {
    if (!deleteContext) return;
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
        message: errorMessage(error, "Erreur lors de la suppression"),
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
    const query = normalizeSearch(searchProducts.trim());
    if (query) {
      filtered = filtered.filter(
        (p) =>
          normalizeSearch(p.name).includes(query) ||
          normalizeSearch(p.category).includes(query) ||
          normalizeSearch(p.notes).includes(query),
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
    const query = normalizeSearch(searchApplications.trim());
    if (query) {
      filtered = filtered.filter((app) => {
        const productNames = app.products.map((p) => p?.product_name).join(" ");
        return (
          normalizeSearch(fmtDate(app.date)).includes(query) ||
          normalizeSearch(productNames).includes(query) ||
          normalizeSearch(app.notes).includes(query)
        );
      });
    }
    if (filterApplicationsYear) {
      filtered = filtered.filter(
        (app) =>
          new Date(app.date).getFullYear() === Number(filterApplicationsYear),
      );
    }
    return [...filtered].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );
  }, [applications, searchApplications, filterApplicationsYear]);

  // ─── Render ──────────────────────────────────────────────────

  return (
    <div className="phyto-page app-page">
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
              <div className="pp-header-actions">
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
                  onClick={() => setModal({ kind: "add-product" })}
                >
                  + Produit
                </button>
              </div>
            </div>

            {!loading && products.length > 0 && (
              <div className="pp-toolbar">
                <input
                  type="text"
                  className="app-input pp-toolbar-search"
                  placeholder="Chercher un produit..."
                  value={searchProducts}
                  onChange={(e) => setSearchProducts(e.target.value)}
                />
                <select
                  className="app-input pp-toolbar-select"
                  value={sortProductsBy}
                  onChange={(e) => setSortProductsBy(e.target.value)}
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
                            onClick={() =>
                              setModal({ kind: "edit-product", product })
                            }
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
                  onClick={() => setModal({ kind: "add-application" })}
                  disabled={products.length === 0}
                >
                  + Intervention
                </button>
              </div>
            </div>

            {!loading && applications.length > 0 && (
              <div className="pp-toolbar">
                <input
                  type="text"
                  className="app-input pp-toolbar-search"
                  placeholder="Chercher une intervention..."
                  value={searchApplications}
                  onChange={(e) => setSearchApplications(e.target.value)}
                />
                <select
                  className="app-input pp-toolbar-select"
                  value={filterApplicationsYear}
                  onChange={(e) => setFilterApplicationsYear(e.target.value)}
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
                            .filter(hasProduct)
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
                          onClick={() =>
                            setModal({ kind: "edit-application", application })
                          }
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
                    {application.products.filter(hasProduct).map((p, idx) => (
                      <div key={idx} className="pp-product-meta-row">
                        <span>{p.product_name}</span>
                        {p.quantity_used != null && (
                          <span className="pp-inline-meta">
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

      {modal?.kind === "add-product" && (
        <Modal title="Ajouter un produit phyto" onClose={() => setModal(null)}>
          <ProductForm
            onSubmit={createProduct}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}

      {modal?.kind === "edit-product" && (
        <Modal title="Modifier le produit" onClose={() => setModal(null)}>
          <ProductForm
            initial={modal.product}
            onSubmit={(payload) => updateProduct(modal.product.id, payload)}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}

      {modal?.kind === "add-application" && (
        <Modal title="Ajouter une intervention" onClose={() => setModal(null)}>
          <ApplicationForm
            products={products}
            onSubmit={createApplication}
            onCancel={() => setModal(null)}
            onAlert={showError}
          />
        </Modal>
      )}

      {modal?.kind === "edit-application" && (
        <Modal title="Modifier l'intervention" onClose={() => setModal(null)}>
          <ApplicationForm
            initial={modal.application}
            products={products}
            onSubmit={(payload) =>
              updateApplication(modal.application.id, payload)
            }
            onCancel={() => setModal(null)}
            onAlert={showError}
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
    </div>
  );
}
