import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";
import { createClient } from '@supabase/supabase-js';

// ─────────────────────────────────────────────
// SUPABASE
// ─────────────────────────────────────────────
const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!
);

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────
type Theme = 'light' | 'dark';
type AppUser = { id: string; email: string; firstName?: string; businessName?: string };
type ToastType = 'success' | 'error' | 'info';
type Toast = { id: number; message: string; type: ToastType };
type ActiveTab = 'calculator' | 'database' | 'insumos';
type AuthScreen = 'login' | 'register';
type AppState = 'loading' | 'auth' | 'app' | 'reset-password';

type IngredientMaster = {
    id: string; name: string; displayName: string;
    unit: string; quantity: number; pricePerUnit: number; lastUpdated: number;
};
type Ingredient = { id: string; name: string; quantity: number; unit: string; pricePerUnit: number };
type CostSettings = {
    safetyFactor: number; laborCost: number; packagingCost: number;
    targetMargin: number; taxRate: number; bankFee: number;
};
type SavedRecipe = {
    id: string; name: string; yield: number; ingredients: Ingredient[];
    settings: CostSettings; lastUpdated: number; finalPrice: number; realPrice?: number;
};

const DEFAULT_SETTINGS: CostSettings = {
    safetyFactor: 3, laborCost: 1500, packagingCost: 500,
    targetMargin: 30, taxRate: 19, bankFee: 2.95,
};

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
const generateId = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

const fileToGenerativePart = async (file: File) =>
    new Promise<{ inlineData: { data: string; mimeType: string } }>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve({ inlineData: { data: (reader.result as string).split(',')[1], mimeType: file.type } });
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });

const formatCLP = (n: number) => new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' }).format(n);
const fmtDots = (v: string | number) => {
    if (v === '' || v == null) return '';
    return v.toString().replace(/\D/g, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
};
const parseDots = (v: string) => parseInt(v.replace(/\./g, ''), 10) || 0;
const normName = (s: string) => s.trim().toLowerCase();

const parseCSVLine = (text: string) => {
    const result: string[] = []; let cur = '', inQ = false;
    for (const c of text) {
        if (c === '"') inQ = !inQ;
        else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
        else cur += c;
    }
    result.push(cur);
    return result.map(s => s.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
};

const calcRecipe = (recipe: SavedRecipe): SavedRecipe => {
    const { settings: s } = recipe;
    const batchIng = recipe.ingredients.reduce((a, i) => a + i.quantity * i.pricePerUnit, 0);
    const total = batchIng * (1 + s.safetyFactor / 100) + s.laborCost + s.packagingCost;
    const unit = recipe.yield > 0 ? total / recipe.yield : 0;
    const m = Math.min(Math.max(s.targetMargin, 0), 99);
    const preTax = unit / (1 - m / 100);
    return { ...recipe, finalPrice: preTax * (1 + s.taxRate / 100) * (1 + s.bankFee / 100) };
};

const realMargin = (r: SavedRecipe) => {
    if (!r.realPrice || r.realPrice <= 0) return 0;
    const batchIng = r.ingredients.reduce((a, i) => a + i.quantity * i.pricePerUnit, 0);
    const total = batchIng * (1 + r.settings.safetyFactor / 100) + r.settings.laborCost + r.settings.packagingCost;
    const unit = r.yield > 0 ? total / r.yield : 0;
    const net = r.realPrice / (1 + r.settings.bankFee / 100) / (1 + r.settings.taxRate / 100);
    return net > 0 ? ((net - unit) / net) * 100 : 0;
};

const syncCatalog = (ings: Ingredient[], catalog: IngredientMaster[], ts: number): IngredientMaster[] => {
    const updated = [...catalog];
    for (const ing of ings) {
        if (!ing.name.trim()) continue;
        const key = normName(ing.name);
        const idx = updated.findIndex(c => c.name === key);
        if (idx === -1) {
            updated.push({ id: generateId(), name: key, displayName: ing.name.trim(), unit: ing.unit, quantity: 1, pricePerUnit: ing.pricePerUnit, lastUpdated: ts });
        } else if (updated[idx].lastUpdated < ts) {
            updated[idx] = { ...updated[idx], pricePerUnit: ing.pricePerUnit, unit: ing.unit, lastUpdated: ts };
        }
    }
    return updated;
};

// ─────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────
const ToastContainer = ({ toasts, onRemove }: { toasts: Toast[]; onRemove: (id: number) => void }) => (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
            <div key={t.id} className={`pointer-events-auto animate-slide-up flex items-center gap-3 px-4 py-3 rounded-xl shadow-card-lg text-sm font-semibold text-white
                ${t.type === 'success' ? 'bg-emerald-600' : t.type === 'error' ? 'bg-red-600' : 'bg-indigo-600'}`}>
                <span>{t.type === 'success' ? '✓' : t.type === 'error' ? '✕' : 'ℹ'}</span>
                <span>{t.message}</span>
                <button onClick={() => onRemove(t.id)} className="ml-1 opacity-60 hover:opacity-100 text-lg leading-none">×</button>
            </div>
        ))}
    </div>
);

// ─────────────────────────────────────────────
// AUTH COMPONENTS
// ─────────────────────────────────────────────
const Field = ({ label, type = 'text', value, onChange, placeholder, autoFocus = false }: {
    label: string; type?: string; value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean;
}) => (
    <div>
        <label className="label">{label}</label>
        <input type={type} autoFocus={autoFocus} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
            className="input" />
    </div>
);

const Spinner = () => <div className="spinner" />;

const AuthCard = ({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle?: string }) => (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)' }}>
        <div className="w-full max-w-md animate-slide-up">
            <div className="text-center mb-8">
                <div className="text-5xl mb-3">🍬</div>
                <h1 className="text-3xl font-extrabold text-white tracking-tight">DolceCostos</h1>
                <p className="text-indigo-300 mt-1 text-sm">{subtitle}</p>
            </div>
            <div className="card p-8" style={{ background: 'var(--card-bg)' }}>
                <h2 className="text-xl font-bold mb-6" style={{ color: 'var(--text-1)' }}>{title}</h2>
                {children}
            </div>
        </div>
    </div>
);

const LoginScreen = ({ onLogin, onGoRegister }: { onLogin: (u: AppUser) => void; onGoRegister: () => void }) => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [showForgot, setShowForgot] = useState(false);
    const [forgotEmail, setForgotEmail] = useState('');
    const [forgotLoading, setForgotLoading] = useState(false);
    const [forgotSent, setForgotSent] = useState(false);
    const [forgotError, setForgotError] = useState('');

    const handleSubmit = async (e: React.BaseSyntheticEvent) => {
        e.preventDefault();
        if (!email || !password) return setError('Completa todos los campos.');
        setLoading(true); setError('');
        try {
            const { data, error: err } = await supabase.auth.signInWithPassword({ email, password });
            if (err) throw err;
            let firstName, businessName;
            try {
                const { data: p } = await supabase.from('users').select('first_name,business_name').eq('id', data.user!.id).single();
                firstName = p?.first_name; businessName = p?.business_name;
            } catch (profileErr) { console.error('[login] error fetching user profile:', profileErr); }
            onLogin({ id: data.user!.id, email: data.user!.email!, firstName, businessName });
        } catch (err: any) {
            const m = err.message || '';
            setError(m.includes('Invalid login') ? 'Email o contraseña incorrectos.' : m.includes('Email not confirmed') ? 'Confirma tu email primero.' : (m || 'Error al iniciar sesión.'));
        } finally { setLoading(false); }
    };

    const handleForgot = async (e: React.BaseSyntheticEvent) => {
        e.preventDefault();
        if (!forgotEmail) return setForgotError('Ingresa tu email.');
        setForgotLoading(true); setForgotError('');
        try {
            const { error: err } = await supabase.auth.resetPasswordForEmail(forgotEmail, { redirectTo: window.location.origin });
            if (err) throw err;
            setForgotSent(true);
        } catch (err: any) { setForgotError(err.message || 'No se pudo enviar el email.'); }
        finally { setForgotLoading(false); }
    };

    return (
        <>
            {showForgot && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)' }}>
                    <div className="card p-7 w-full max-w-sm animate-slide-up" style={{ background: 'var(--card-bg)' }}>
                        {forgotSent ? (
                            <div className="text-center py-2">
                                <div className="text-5xl mb-4">📬</div>
                                <h3 className="font-bold text-lg mb-2" style={{ color: 'var(--text-1)' }}>¡Email enviado!</h3>
                                <p className="text-sm mb-5" style={{ color: 'var(--text-2)' }}>Revisa tu bandeja en <strong>{forgotEmail}</strong> y sigue el enlace para crear tu nueva contraseña.</p>
                                <button className="btn-primary w-full py-3" onClick={() => { setShowForgot(false); setForgotSent(false); setForgotEmail(''); }}>Listo</button>
                            </div>
                        ) : (
                            <>
                                <div className="flex items-center justify-between mb-5">
                                    <h3 className="font-bold text-lg" style={{ color: 'var(--text-1)' }}>Recuperar contraseña</h3>
                                    <button className="btn-icon" onClick={() => setShowForgot(false)}>✕</button>
                                </div>
                                <p className="text-sm mb-5" style={{ color: 'var(--text-2)' }}>Ingresa tu email y te enviaremos un enlace de restablecimiento.</p>
                                {forgotError && <div className="alert-error mb-4"><span>⚠</span>{forgotError}</div>}
                                <form onSubmit={handleForgot} className="space-y-4">
                                    <Field label="Email" type="email" value={forgotEmail} onChange={setForgotEmail} placeholder="tu@email.com" autoFocus />
                                    <button type="submit" disabled={forgotLoading} className="btn-primary w-full py-3">
                                        {forgotLoading ? <Spinner /> : '📧 Enviar enlace'}
                                    </button>
                                </form>
                            </>
                        )}
                    </div>
                </div>
            )}
            <AuthCard title="Iniciar Sesión" subtitle="Calculadora profesional de costos">
                {error && <div className="alert-error mb-5"><span>⚠</span><span>{error}</span></div>}
                <form onSubmit={handleSubmit} className="space-y-4">
                    <Field label="Email" type="email" value={email} onChange={setEmail} placeholder="tu@email.com" autoFocus />
                    <div>
                        <div className="flex items-center justify-between mb-1.5">
                            <span className="label mb-0">Contraseña</span>
                            <button type="button" onClick={() => { setShowForgot(true); setForgotEmail(email); }}
                                className="text-xs font-semibold transition-colors" style={{ color: 'var(--accent)' }}>
                                ¿Olvidaste tu contraseña?
                            </button>
                        </div>
                        <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" className="input" />
                    </div>
                    <button type="submit" disabled={loading} className="btn-primary w-full py-3 mt-1">
                        {loading ? <Spinner /> : 'Ingresar →'}
                    </button>
                </form>
                <p className="text-center text-sm mt-6" style={{ color: 'var(--text-2)' }}>
                    ¿No tienes cuenta?{' '}
                    <button onClick={onGoRegister} className="font-bold hover:underline" style={{ color: 'var(--accent)' }}>Registrarse</button>
                </p>
            </AuthCard>
        </>
    );
};

const RegisterScreen = ({ onRegister, onGoLogin }: { onRegister: (u: AppUser) => void; onGoLogin: () => void }) => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [firstName, setFirstName] = useState('');
    const [businessName, setBusinessName] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);

    const handleSubmit = async (e: React.BaseSyntheticEvent) => {
        e.preventDefault();
        if (!email || !password || !firstName) return setError('Email, contraseña y nombre son obligatorios.');
        if (password.length < 6) return setError('La contraseña debe tener al menos 6 caracteres.');
        if (password !== confirm) return setError('Las contraseñas no coinciden.');
        setLoading(true); setError('');
        try {
            const { data, error: err } = await supabase.auth.signUp({ email, password });
            if (err) throw err;
            const now = new Date().toISOString();
            const { error: insertErr } = await supabase.from('users').insert({ id: data.user!.id, email, first_name: firstName, role: 'owner', business_name: businessName || null, owner_id: null, created_at: now, updated_at: now });
            if (insertErr) {
                console.error('[signup] error inserting user profile:', insertErr);
                setError('Tu cuenta fue creada pero no pudimos guardar tu perfil. Contactá al soporte.');
                setLoading(false);
                return;
            }
            if (data.session) onRegister({ id: data.user!.id, email, firstName, businessName: businessName || undefined });
            else setSuccess(true);
        } catch (err: any) {
            const m = err.message || '';
            setError(m.includes('already registered') ? 'Ese email ya está registrado.' : (m || 'Error al registrarse.'));
        } finally { setLoading(false); }
    };

    if (success) return (
        <AuthCard title="¡Revisa tu email!" subtitle="Casi listo">
            <div className="text-center py-2">
                <div className="text-5xl mb-4">📬</div>
                <p className="text-sm mb-6" style={{ color: 'var(--text-2)' }}>Enviamos un enlace de confirmación a <strong>{email}</strong>. Confírmalo para activar tu cuenta.</p>
                <button onClick={onGoLogin} className="btn-primary w-full py-3">← Iniciar sesión</button>
            </div>
        </AuthCard>
    );

    return (
        <AuthCard title="Crear Cuenta" subtitle="Empieza gratis hoy">
            {error && <div className="alert-error mb-5"><span>⚠</span><span>{error}</span></div>}
            <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                    <Field label="Nombre *" value={firstName} onChange={setFirstName} placeholder="Tu nombre" autoFocus />
                    <Field label="Nombre del negocio" value={businessName} onChange={setBusinessName} placeholder="Pastelería..." />
                </div>
                <Field label="Email *" type="email" value={email} onChange={setEmail} placeholder="tu@email.com" />
                <Field label="Contraseña * (mín. 6)" type="password" value={password} onChange={setPassword} placeholder="••••••••" />
                <Field label="Confirmar contraseña *" type="password" value={confirm} onChange={setConfirm} placeholder="••••••••" />
                <button type="submit" disabled={loading} className="btn-success w-full py-3 mt-1">
                    {loading ? <Spinner /> : 'Crear Cuenta →'}
                </button>
            </form>
            <p className="text-center text-sm mt-6" style={{ color: 'var(--text-2)' }}>
                ¿Ya tienes cuenta?{' '}
                <button onClick={onGoLogin} className="font-bold hover:underline" style={{ color: 'var(--accent)' }}>Iniciar Sesión</button>
            </p>
        </AuthCard>
    );
};

const ResetPasswordScreen = ({ onDone }: { onDone: () => void }) => {
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);
    const [linkExpired, setLinkExpired] = useState(false);

    useEffect(() => {
        const hash = window.location.hash;
        const params = new URLSearchParams(hash.replace('#', ''));

        // Check for error in URL (e.g., otp_expired, access_denied)
        if (params.get('error') || params.get('error_code')) {
            const errorDesc = params.get('error_description') || 'El enlace de recuperación es inválido o ha expirado.';
            setError(decodeURIComponent(errorDesc.replace(/\+/g, ' ')));
            setLinkExpired(true);
            window.history.replaceState(null, '', window.location.pathname);
        }
    }, []);

    const handleSubmit = async (e: React.BaseSyntheticEvent) => {
        e.preventDefault();
        if (!password || !confirm) return setError('Completa ambos campos.');
        if (password.length < 6) return setError('Mínimo 6 caracteres.');
        if (password !== confirm) return setError('Las contraseñas no coinciden.');
        setLoading(true); setError('');
        try {
            const { error: err } = await supabase.auth.updateUser({ password });
            if (err) throw err;
            setSuccess(true);
            window.history.replaceState(null, '', window.location.pathname);
            setTimeout(onDone, 2500);
        } catch (err: any) { setError(err.message || 'No se pudo actualizar la contraseña.'); }
        finally { setLoading(false); }
    };

    return (
        <AuthCard title={success ? '¡Contraseña actualizada!' : 'Nueva Contraseña'} subtitle="DolceCostos">
            {success ? (
                <div className="text-center py-2">
                    <div className="text-5xl mb-4">✅</div>
                    <p className="text-sm" style={{ color: 'var(--text-2)' }}>Redirigiendo a la app...</p>
                </div>
            ) : linkExpired ? (
                <div className="text-center py-4 space-y-4">
                    <div className="text-5xl mb-4">⏰</div>
                    <p className="text-sm mb-3" style={{ color: 'var(--text-2)' }}>{error}</p>
                    <p className="text-xs mb-4" style={{ color: 'var(--text-3)' }}>Solicita un nuevo enlace para recuperar tu contraseña.</p>
                    <button onClick={onDone} className="btn-primary w-full py-3">
                        Volver a iniciar sesión
                    </button>
                </div>
            ) : (
                <>
                    {error && <div className="alert-error mb-4"><span>⚠</span><span>{error}</span></div>}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <Field label="Nueva contraseña (mín. 6 caracteres)" type="password" value={password} onChange={setPassword} placeholder="••••••••" autoFocus />
                        <Field label="Confirmar nueva contraseña" type="password" value={confirm} onChange={setConfirm} placeholder="••••••••" />
                        <button type="submit" disabled={loading} className="btn-success w-full py-3 mt-1">
                            {loading ? <Spinner /> : '🔒 Guardar nueva contraseña'}
                        </button>
                    </form>
                </>
            )}
        </AuthCard>
    );
};

// ─────────────────────────────────────────────
// INSUMOS TAB
// ─────────────────────────────────────────────
const InsumosCatalogTab = ({ catalog, recipes, currentUser, onCatalogChange, onBatchUpdateRecipes, addToast }: {
    catalog: IngredientMaster[]; recipes: SavedRecipe[]; currentUser: AppUser | null;
    onCatalogChange: (c: IngredientMaster[]) => void;
    onBatchUpdateRecipes: (r: SavedRecipe[]) => void;
    addToast: (m: string, t?: ToastType) => void;
}) => {
    const [searchCat, setSearchCat] = useState('');
    const [newIng, setNewIng] = useState({ displayName: '', quantity: '1', unit: 'un', price: '' });
    const [editId, setEditId] = useState<string | null>(null);
    const [editRow, setEditRow] = useState<Partial<IngredientMaster & { priceStr: string; quantity: string }>>({});
    const [batchSearch, setBatchSearch] = useState('');
    const [editedPrices, setEditedPrices] = useState<Record<string, string>>({});
    const [showActions, setShowActions] = useState(false);
    const catalogRef = useRef<HTMLInputElement>(null);

    const filteredCat = catalog
        .filter(c => c.displayName.toLowerCase().includes(searchCat.toLowerCase()))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));

    const recipeIngs = React.useMemo(() => {
        const map = new Map<string, { price: number; count: number; display: string }>();
        recipes.forEach(r => r.ingredients.forEach(i => {
            const k = normName(i.name);
            if (!map.has(k)) map.set(k, { price: i.pricePerUnit, count: 1, display: i.name.trim() });
            else map.get(k)!.count++;
        }));
        return Array.from(map.entries())
            .map(([k, v]) => ({ key: k, ...v }))
            .filter(i => i.display.toLowerCase().includes(batchSearch.toLowerCase()))
            .sort((a, b) => b.count - a.count);
    }, [recipes, batchSearch]);

    const handleAdd = () => {
        if (!newIng.displayName.trim()) return addToast('Ingresa un nombre', 'error');
        const key = normName(newIng.displayName);
        if (catalog.some(c => c.name === key)) return addToast('Ya existe ese insumo', 'error');
        const qty = parseFloat(newIng.quantity) || 1;
        onCatalogChange([...catalog, { id: generateId(), name: key, displayName: newIng.displayName.trim(), unit: newIng.unit || 'un', quantity: qty, pricePerUnit: parseDots(newIng.price) || 0, lastUpdated: Date.now() }]);
        setNewIng({ displayName: '', quantity: '1', unit: 'un', price: '' });
        addToast('Insumo agregado al catálogo', 'success');
    };

    const handleApplyBatch = () => {
        const keys = Object.keys(editedPrices);
        if (!keys.length) return;
        const updated = recipes.map(recipe => {
            let changed = false;
            const newIngs = recipe.ingredients.map(ing => {
                const k = normName(ing.name);
                const val = editedPrices[k];
                if (val) { const np = parseDots(val); if (!isNaN(np) && Math.abs(np - ing.pricePerUnit) > 0.01) { changed = true; return { ...ing, pricePerUnit: np }; } }
                return ing;
            });
            return changed ? calcRecipe({ ...recipe, ingredients: newIngs, lastUpdated: Date.now() }) : recipe;
        });
        let newCat = [...catalog];
        keys.forEach(k => { const np = parseDots(editedPrices[k]); const i = newCat.findIndex(c => c.name === k); if (i >= 0) newCat[i] = { ...newCat[i], pricePerUnit: np, lastUpdated: Date.now() }; });
        onBatchUpdateRecipes(updated);
        onCatalogChange(newCat);
        setEditedPrices({});
        addToast(`Precios actualizados en ${updated.filter((r, i) => r !== recipes[i]).length} recetas`, 'success');
    };

    const exportCatalogJSON = () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(catalog, null, 2)], { type: 'application/json' }));
        a.download = `catalogo_insumos.json`;
        a.click();
        addToast(`${catalog.length} insumos exportados`, 'success');
    };

    const exportCatalogCSV = () => {
        const rows = catalog.map(c => [c.displayName, c.unit, c.pricePerUnit].join(','));
        const csv = 'data:text/csv;charset=utf-8,' + ['Insumo,Unidad,Precio'.concat('\n'), ...rows].join('\n');
        const a = document.createElement('a');
        a.href = encodeURI(csv);
        a.download = `catalogo_insumos.csv`;
        a.click();
        addToast(`${catalog.length} insumos exportados`, 'success');
    };

    const importCatalogJSON = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            try {
                const imported = JSON.parse(ev.target?.result as string);
                if (!Array.isArray(imported)) throw new Error();
                onCatalogChange(imported);
                addToast(`${imported.length} insumos importados`, 'success');
            } catch {
                addToast('Archivo de catálogo inválido', 'error');
            }
        };
        reader.readAsText(file);
    };

    const resetPrices = () => {
        if (confirm('¿Establecer todos los precios a $0? Esta acción puede afectar los cálculos de recetas.')) {
            onCatalogChange(catalog.map(c => ({ ...c, pricePerUnit: 0, lastUpdated: Date.now() })));
            addToast('Precios reiniciados', 'success');
        }
    };

    const handleDeleteIngredient = async (id: string, displayName: string) => {
        if (confirm(`¿Eliminar "${displayName}"?`)) {
            onCatalogChange(catalog.filter(c => c.id !== id));
            addToast(`"${displayName}" eliminado`);
            if (currentUser) {
                try {
                    await supabase.from('ingredient_catalog').delete().eq('id', id).eq('user_id', currentUser.id);
                } catch (err) {
                    console.error('Error deleting ingredient:', err);
                }
            }
        }
    };


    return (
        <div className="space-y-6">
            {/* CATÁLOGO */}
            <div className="card overflow-hidden">
                <div className="px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3" style={{ borderBottom: '1px solid var(--border)' }}>
                    <div className="section-header mb-0">
                        <p className="section-title">📚 Catálogo de Insumos</p>
                        <p className="section-subtitle">{catalog.length} insumos · Se completa automáticamente al guardar recetas</p>
                    </div>
                    <div className="flex gap-2 items-center w-full sm:w-auto">
                        <input value={searchCat} onChange={e => setSearchCat(e.target.value)} placeholder="Buscar insumo..."
                            className="input text-sm flex-1 sm:flex-none sm:w-56" />
                        <div className="relative">
                            <button onClick={() => setShowActions(!showActions)} className="btn-ghost text-sm px-3 py-2 flex items-center gap-1" title="Opciones de catálogo">
                                ⚙️ Acciones
                            </button>
                            {showActions && (
                                <div className="absolute right-0 mt-1 w-48 bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 z-10">
                                    <button onClick={() => { exportCatalogJSON(); setShowActions(false); }} className="w-full text-left px-4 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-700 border-b border-slate-200 dark:border-slate-700">📥 Exportar JSON</button>
                                    <button onClick={() => { exportCatalogCSV(); setShowActions(false); }} className="w-full text-left px-4 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-700 border-b border-slate-200 dark:border-slate-700">📊 Exportar CSV</button>
                                    <button onClick={() => { catalogRef.current?.click(); setShowActions(false); }} className="w-full text-left px-4 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-700 border-b border-slate-200 dark:border-slate-700">📤 Importar</button>
                                    <button onClick={() => { resetPrices(); setShowActions(false); }} className="w-full text-left px-4 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-700 text-red-600">🔄 Reiniciar precios</button>
                                </div>
                            )}
                            <input type="file" ref={catalogRef} className="hidden" accept=".json" onChange={importCatalogJSON} />
                        </div>
                    </div>
                </div>

                <div className="overflow-x-auto">
                    <table className="tbl">
                        <thead><tr>
                            <th>Insumo</th><th>Presentación</th><th>Precio / Uni</th><th className="text-right">Acciones</th>
                        </tr></thead>
                        <tbody>
                            {/* Fila nueva */}
                            <tr style={{ background: 'color-mix(in srgb, var(--accent) 5%, transparent)' }}>
                                <td><input value={newIng.displayName} onChange={e => setNewIng({ ...newIng, displayName: e.target.value })} onKeyDown={e => e.key === 'Enter' && handleAdd()} placeholder="Nuevo insumo..." className="input-sm w-full" /></td>
                                <td className="flex gap-1">
                                    <input type="number" inputMode="decimal" value={newIng.quantity} onChange={e => setNewIng({ ...newIng, quantity: e.target.value })} placeholder="1" className="input-sm w-14" step="0.1" min="0.1" />
                                    <select value={newIng.unit} onChange={e => setNewIng({ ...newIng, unit: e.target.value })} className="input-sm flex-1">
                                        <option value="un">Unidad</option>
                                        <option value="kg">KG</option>
                                        <option value="g">G</option>
                                        <option value="l">L</option>
                                        <option value="ml">ML</option>
                                    </select>
                                </td>
                                <td>
                                    <div className="relative">
                                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs" style={{ color: 'var(--text-3)' }}>$</span>
                                        <input type="text" inputMode="numeric" value={newIng.price} onChange={e => setNewIng({ ...newIng, price: fmtDots(e.target.value.replace(/\D/g, '')) })} onKeyDown={e => e.key === 'Enter' && handleAdd()} placeholder="0" className="input-sm w-32 pl-5 font-mono" />
                                    </div>
                                </td>
                                <td className="text-right"><button onClick={handleAdd} className="btn-primary text-xs px-3 py-1.5">+ Agregar</button></td>
                            </tr>

                            {filteredCat.length === 0 ? (
                                <tr><td colSpan={4} className="py-10 text-center text-sm" style={{ color: 'var(--text-3)' }}>
                                    {searchCat ? 'Sin resultados.' : 'El catálogo está vacío. Agrega insumos aquí o guarda una receta.'}
                                </td></tr>
                            ) : filteredCat.map(item => (
                                <tr key={item.id}>
                                    {editId === item.id ? (
                                        <>
                                            <td><input autoFocus value={editRow.displayName as string || ''} onChange={e => setEditRow({ ...editRow, displayName: e.target.value })} className="input-sm w-full" /></td>
                                            <td className="flex gap-1">
                                                <input type="number" inputMode="decimal" value={editRow.quantity || item.quantity} onChange={e => setEditRow({ ...editRow, quantity: e.target.value })} className="input-sm w-14" step="0.1" min="0.1" />
                                                <select value={editRow.unit as string || 'un'} onChange={e => setEditRow({ ...editRow, unit: e.target.value })} className="input-sm flex-1">
                                                    <option value="un">Unidad</option>
                                                    <option value="kg">KG</option>
                                                    <option value="g">G</option>
                                                    <option value="l">L</option>
                                                    <option value="ml">ML</option>
                                                </select>
                                            </td>
                                            <td><input type="text" inputMode="numeric" value={editRow.priceStr || ''} onChange={e => setEditRow({ ...editRow, priceStr: fmtDots(e.target.value.replace(/\D/g, '')) })} onKeyDown={e => e.key === 'Enter' && (() => { const qty = parseFloat(editRow.quantity as string) || item.quantity; onCatalogChange(catalog.map(c => c.id === item.id ? { ...c, displayName: (editRow.displayName || c.displayName).trim(), name: normName(editRow.displayName || c.displayName), unit: editRow.unit || c.unit, quantity: qty, pricePerUnit: parseDots(editRow.priceStr || '0') || c.pricePerUnit, lastUpdated: Date.now() } : c)); setEditId(null); addToast('Insumo actualizado', 'success'); })()} className="input-sm w-32 font-mono" /></td>
                                            <td className="text-right">
                                                <div className="flex justify-end gap-1">
                                                    <button className="btn-success text-xs px-2 py-1" onClick={() => { const qty = parseFloat(editRow.quantity as string) || item.quantity; onCatalogChange(catalog.map(c => c.id === item.id ? { ...c, displayName: (editRow.displayName || c.displayName).trim(), name: normName(editRow.displayName || c.displayName), unit: editRow.unit || c.unit, quantity: qty, pricePerUnit: parseDots(editRow.priceStr || '0') || c.pricePerUnit, lastUpdated: Date.now() } : c)); setEditId(null); addToast('Insumo actualizado', 'success'); }}>✓</button>
                                                    <button className="btn-ghost text-xs px-2 py-1" onClick={() => setEditId(null)}>✕</button>
                                                </div>
                                            </td>
                                        </>
                                    ) : (
                                        <>
                                            <td className="font-medium">{item.displayName}</td>
                                            <td style={{ color: 'var(--text-2)' }}>{item.quantity} {item.unit}</td>
                                            <td className="price-display" style={{ color: 'var(--text-1)' }}>{formatCLP(item.pricePerUnit)}</td>
                                            <td className="text-right">
                                                <div className="flex justify-end gap-0.5">
                                                    <button className="btn-icon" onClick={() => { setEditId(item.id); setEditRow({ displayName: item.displayName, quantity: item.quantity.toString(), unit: item.unit, priceStr: fmtDots(item.pricePerUnit) }); }} title="Editar">
                                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                                    </button>
                                                    <button className="btn-danger" onClick={() => handleDeleteIngredient(item.id, item.displayName)} title="Eliminar">
                                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                                    </button>
                                                </div>
                                            </td>
                                        </>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* BATCH UPDATE */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                <div className="lg:col-span-2 card overflow-hidden">
                    <div className="px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3" style={{ borderBottom: '1px solid var(--border)' }}>
                        <div className="section-header mb-0">
                            <p className="section-title">⚡ Actualizar Precios en Recetas</p>
                            <p className="section-subtitle">Un cambio aquí se aplica en todas las recetas</p>
                        </div>
                        <div className="flex gap-2">
                            <input value={batchSearch} onChange={e => setBatchSearch(e.target.value)} placeholder="Buscar..." className="input text-sm w-48" />
                            {Object.keys(editedPrices).length > 0 && (
                                <button onClick={handleApplyBatch} className="btn-success px-4 py-2 animate-pulse">
                                    Aplicar ({Object.keys(editedPrices).length})
                                </button>
                            )}
                        </div>
                    </div>
                    <table className="tbl">
                        <thead><tr><th>Insumo</th><th className="text-center">Recetas</th><th>Precio actual</th><th>Nuevo precio</th></tr></thead>
                        <tbody>
                            {recipeIngs.length === 0 ? (
                                <tr><td colSpan={4} className="py-8 text-center text-sm" style={{ color: 'var(--text-3)' }}>Sin insumos en recetas guardadas.</td></tr>
                            ) : recipeIngs.map(ing => (
                                <tr key={ing.key}>
                                    <td className="font-medium">{ing.display}</td>
                                    <td className="text-center"><span className="badge badge-neutral">{ing.count}</span></td>
                                    <td className="price-display text-sm" style={{ color: 'var(--text-2)' }}>{formatCLP(ing.price)}</td>
                                    <td>
                                        <div className="relative w-36">
                                            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs" style={{ color: 'var(--text-3)' }}>$</span>
                                            <input type="text" inputMode="numeric" placeholder={fmtDots(ing.price)} value={editedPrices[ing.key] || ''}
                                                onChange={e => { const r = e.target.value.replace(/\D/g, ''); setEditedPrices(prev => r === '' ? (() => { const n = { ...prev }; delete n[ing.key]; return n; })() : { ...prev, [ing.key]: fmtDots(r) }); }}
                                                onKeyDown={e => e.key === 'Enter' && handleApplyBatch()}
                                                className={`input-sm pl-6 w-full font-mono ${editedPrices[ing.key] ? 'text-emerald-600 dark:text-emerald-400' : ''}`} />
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

// ─────────────────────────────────────────────
// DATABASE TAB
// ─────────────────────────────────────────────
const DatabaseTab = ({ recipes, onEdit, onDelete, onImport, addToast }: {
    recipes: SavedRecipe[]; onEdit: (r: SavedRecipe) => void;
    onDelete: (id: string) => void; onImport: (r: SavedRecipe[]) => void;
    addToast: (m: string, t?: ToastType) => void;
}) => {
    const backupRef = useRef<HTMLInputElement>(null);
    const csvRef = useRef<HTMLInputElement>(null);
    const [search, setSearch] = useState('');

    const exportCSV = () => {
        const rows = recipes.map(r => [r.id, `"${r.name.replace(/"/g, '""')}"`, r.yield, r.finalPrice, r.realPrice || 0, realMargin(r).toFixed(2)].join(','));
        const csv = 'data:text/csv;charset=utf-8,' + ['ID,Nombre,Rendimiento,Sugerido,Precio Real,Margen %', ...rows].join('\n');
        const a = document.createElement('a'); a.href = encodeURI(csv); a.download = `dolce_${new Date().toLocaleDateString('es-CL').replace(/\//g, '-')}.csv`; a.click();
        addToast(`${recipes.length} recetas exportadas`, 'success');
    };

    const importCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            const lines = (ev.target?.result as string).split('\n');
            let n = 0; const updated = [...recipes];
            for (let i = 1; i < lines.length; i++) {
                if (!lines[i].trim()) continue;
                const cols = parseCSVLine(lines[i]);
                if (cols.length < 5) continue;
                const idx = updated.findIndex(r => r.id === cols[0]);
                const rp = parseFloat(cols[4]);
                if (idx >= 0 && !isNaN(rp)) { updated[idx] = { ...updated[idx], realPrice: rp, lastUpdated: Date.now() }; n++; }
            }
            if (n > 0) { onImport(updated); addToast(`${n} recetas actualizadas`, 'success'); }
            else addToast('Sin coincidencias en el CSV', 'error');
        };
        reader.readAsText(file);
    };

    const exportJSON = () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(recipes, null, 2)], { type: 'application/json' }));
        a.download = `dolce_backup.json`; a.click();
        addToast('Backup descargado', 'success');
    };

    const importJSON = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            try {
                const raw = JSON.parse(ev.target?.result as string);
                if (!Array.isArray(raw)) throw new Error();
                const sanitized = raw.map((r: any) => ({ ...r, settings: { ...DEFAULT_SETTINGS, ...(r.settings || {}) } }));
                if (confirm(`¿Restaurar ${sanitized.length} recetas?`)) { onImport(sanitized); addToast(`${sanitized.length} recetas restauradas`, 'success'); }
            } catch { addToast('Archivo inválido', 'error'); }
        };
        reader.readAsText(file);
    };

    const filtered = recipes.filter(r => r.name.toLowerCase().includes(search.toLowerCase()));
    const validMg = recipes.filter(r => r.realPrice && r.realPrice > 0);
    const avgMg = validMg.length ? validMg.reduce((a, r) => a + realMargin(r), 0) / validMg.length : 0;
    const totalVal = recipes.reduce((a, r) => a + (r.realPrice || r.finalPrice), 0);

    return (
        <div className="space-y-5">
            {/* Stats */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="stat-card">
                    <div className="stat-icon" style={{ background: 'color-mix(in srgb, var(--accent) 12%, transparent)' }}>
                        <svg className="w-5 h-5" style={{ color: 'var(--accent)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
                    </div>
                    <div><p className="label mb-0.5">Recetas guardadas</p><p className="text-2xl font-bold price-display">{recipes.length}</p></div>
                </div>
                <div className="stat-card">
                    <div className="stat-icon" style={{ background: 'color-mix(in srgb, var(--success) 12%, transparent)' }}>
                        <svg className="w-5 h-5" style={{ color: 'var(--success)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
                    </div>
                    <div><p className="label mb-0.5">Margen real promedio</p><p className={`text-2xl font-bold price-display ${avgMg >= 30 ? 'text-emerald-500' : 'text-amber-500'}`}>{avgMg.toFixed(1)}%</p></div>
                </div>
                <div className="stat-card">
                    <div className="stat-icon" style={{ background: 'color-mix(in srgb, #3b82f6 12%, transparent)' }}>
                        <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    </div>
                    <div><p className="label mb-0.5">Valor catálogo</p><p className="text-xl font-bold price-display">{formatCLP(totalVal)}</p></div>
                </div>
            </div>

            {/* Toolbar */}
            <div className="card px-4 py-3 flex flex-col sm:flex-row justify-between items-center gap-3">
                <div className="relative w-full sm:w-72">
                    <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-3)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                    <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar receta..." className="input pl-9 text-sm w-full" />
                </div>
                <div className="flex flex-wrap gap-2 justify-end">
                    <button onClick={exportCSV} className="btn-ghost text-xs px-3 py-2 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800">↓ CSV</button>
                    <button onClick={() => csvRef.current?.click()} className="btn-ghost text-xs px-3 py-2">↑ CSV</button>
                    <input ref={csvRef} type="file" accept=".csv" onChange={importCSV} onClick={e => (e.currentTarget.value = '')} className="hidden" />
                    <div className="w-px self-stretch" style={{ background: 'var(--border)' }} />
                    <button onClick={exportJSON} className="btn-ghost text-xs px-3 py-2">💾 Backup</button>
                    <button onClick={() => backupRef.current?.click()} className="btn-ghost text-xs px-3 py-2">↩ Restaurar</button>
                    <input ref={backupRef} type="file" accept=".json" onChange={importJSON} onClick={e => (e.currentTarget.value = '')} className="hidden" />
                </div>
            </div>

            {/* Table */}
            <div className="card overflow-hidden">
                <table className="tbl">
                    <thead><tr>
                        <th>Receta</th><th className="text-center w-16">Uni.</th>
                        <th className="text-right">Sugerido</th><th className="text-right">Precio Real</th>
                        <th className="text-center">Margen</th><th className="text-right w-24">Acciones</th>
                    </tr></thead>
                    <tbody>
                        {filtered.length === 0 ? (
                            <tr><td colSpan={6} className="py-12 text-center text-sm" style={{ color: 'var(--text-3)' }}>
                                {search ? 'Sin resultados.' : '¡Aún no tienes recetas! Ve a Calculadora para crear la primera.'}
                            </td></tr>
                        ) : filtered.map(r => {
                            const mg = realMargin(r);
                            return (
                                <tr key={r.id}>
                                    <td className="font-semibold">{r.name}</td>
                                    <td className="text-center" style={{ color: 'var(--text-2)' }}>{r.yield}</td>
                                    <td className="text-right price-display text-sm" style={{ color: 'var(--text-2)' }}>{formatCLP(r.finalPrice)}</td>
                                    <td className="text-right price-display font-semibold" style={{ color: 'var(--accent)' }}>
                                        {r.realPrice ? formatCLP(r.realPrice) : <span style={{ color: 'var(--text-3)' }}>—</span>}
                                    </td>
                                    <td className="text-center">
                                        {r.realPrice ? <span className={`badge ${mg >= r.settings.targetMargin ? 'badge-success' : 'badge-danger'}`}>{mg.toFixed(1)}%</span> : <span style={{ color: 'var(--text-3)' }}>—</span>}
                                    </td>
                                    <td className="text-right">
                                        <div className="flex justify-end gap-0.5">
                                            <button className="btn-icon" onClick={() => onEdit(r)} title="Editar">
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                            </button>
                                            <button className="btn-danger" onClick={() => onDelete(r.id)} title="Eliminar">
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <div className="alert-info text-xs" style={{ color: 'var(--text-2)' }}>
                <span style={{ color: 'var(--accent)' }}>💡</span>
                <span><strong style={{ color: 'var(--text-1)' }}>Tus datos se guardan en la nube.</strong> Podés acceder desde cualquier dispositivo. Usá "Backup" para exportar una copia local y "Restaurar" para importarla.</span>
            </div>
        </div>
    );
};

// ─────────────────────────────────────────────
// CALCULATOR TAB
// ─────────────────────────────────────────────
const CalculatorTab = ({ initialRecipe, catalog, onSave, addToast }: {
    initialRecipe?: SavedRecipe | null; catalog: IngredientMaster[];
    onSave: (r: SavedRecipe) => void; addToast: (m: string, t?: ToastType) => void;
}) => {
    const [recipeId, setRecipeId] = useState<string | null>(null);
    const [name, setName] = useState('');
    const [yld, setYld] = useState(1);
    const [ings, setIngs] = useState<Ingredient[]>([]);
    const [settings, setSettings] = useState<CostSettings>(DEFAULT_SETTINGS);
    const [realPrice, setRealPrice] = useState(0);

    useEffect(() => {
        if (initialRecipe) {
            setRecipeId(initialRecipe.id); setName(initialRecipe.name); setYld(initialRecipe.yield);
            setIngs(initialRecipe.ingredients); setSettings(initialRecipe.settings); setRealPrice(initialRecipe.realPrice || 0);
        }
    }, [initialRecipe]);

    const reset = () => { setRecipeId(null); setName(''); setYld(1); setIngs([]); setSettings(DEFAULT_SETTINGS); setRealPrice(0); };

    const batchIng = ings.reduce((a, i) => a + i.quantity * i.pricePerUnit, 0);
    const batchSafety = batchIng * (settings.safetyFactor / 100);
    const totalBatch = batchIng + batchSafety + settings.laborCost + settings.packagingCost;
    const unitCost = yld > 0 ? totalBatch / yld : 0;
    const margin = Math.min(Math.max(settings.targetMargin, 0), 99);
    const preTax = unitCost / (1 - margin / 100);
    const profit = preTax - unitCost;
    const tax = preTax * (settings.taxRate / 100);
    const bankFee = (preTax + tax) * (settings.bankFee / 100);
    const finalPrice = (preTax + tax) * (1 + settings.bankFee / 100);
    const realNet = realPrice > 0 ? realPrice / (1 + settings.bankFee / 100) / (1 + settings.taxRate / 100) : 0;
    const realMg = realNet > 0 ? ((realNet - unitCost) / realNet) * 100 : 0;

    const save = () => {
        if (!name.trim()) return addToast('Asigna un nombre a la receta', 'error');
        const r: SavedRecipe = { id: recipeId || generateId(), name: name.trim(), yield: yld, ingredients: ings, settings, lastUpdated: Date.now(), finalPrice, realPrice: realPrice > 0 ? realPrice : undefined };
        onSave(r); if (!recipeId) setRecipeId(r.id);
    };

    const addIng = () => setIngs([...ings, { id: generateId(), name: '', quantity: 0, unit: 'un', pricePerUnit: 0 }]);
    const updateIng = (id: string, field: keyof Ingredient, value: any) => setIngs(p => p.map(i => i.id === id ? { ...i, [field]: value } : i));

    const handleIngName = (id: string, val: string) => {
        updateIng(id, 'name', val);
        const match = catalog.find(c => c.name === normName(val));
        if (match) setIngs(p => p.map(i => i.id === id ? { ...i, name: val, unit: match.unit, quantity: match.quantity, pricePerUnit: match.pricePerUnit } : i));
    };

    const recipeSchema = { type: Type.OBJECT, properties: { name: { type: Type.STRING }, yield: { type: Type.NUMBER }, ingredients: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, quantity: { type: Type.NUMBER }, unit: { type: Type.STRING }, pricePerUnit: { type: Type.NUMBER } } } } } };

    const applyRecipeData = (data: any) => {
        if (data.name) setName(data.name);
        if (data.yield) setYld(Number(data.yield) || 1);
        if (Array.isArray(data.ingredients)) {
            setIngs(data.ingredients.map((item: any) => ({
                id: generateId(),
                name: item.name || '', quantity: Number(item.quantity) || 0, unit: item.unit || 'un',
                pricePerUnit: (() => { const m = catalog.find(c => c.name === normName(item.name || '')); return m ? m.pricePerUnit : (Number(item.pricePerUnit) || 0); })(),
            })));
        }
    };

    const CostRow = ({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) => (
        <div className="flex items-center justify-between py-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
            <span className="text-sm" style={{ color: accent ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.6)' }}>{label}</span>
            <span className="price-display text-sm font-semibold text-white">{value}</span>
        </div>
    );

    const SettingRow = ({ label, stateKey, suffix }: { label: string; stateKey: keyof CostSettings; suffix: string }) => (
        <div className="flex items-center justify-between py-1.5">
            <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.5)' }}>{label}</span>
            <div className="flex items-center gap-1">
                {suffix !== '%' && <span className="text-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>$</span>}
                <input type="number" value={(settings as any)[stateKey]}
                    onChange={e => setSettings({ ...settings, [stateKey]: parseFloat(e.target.value) || 0 })}
                    className="w-20 h-7 text-right text-xs text-white border-none rounded-md outline-none focus:ring-1 focus:ring-indigo-400"
                    style={{ background: 'rgba(255,255,255,0.08)' }} />
                {suffix === '%' && <span className="text-xs w-3" style={{ color: 'rgba(255,255,255,0.4)' }}>%</span>}
            </div>
        </div>
    );

    return (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
            <datalist id="catalog-list">{catalog.map(c => <option key={c.id} value={c.displayName} />)}</datalist>

            <div className="xl:col-span-8 space-y-4">
                {/* Header */}
                <div className="card px-5 py-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                    <div>
                        <p className="font-bold text-base" style={{ color: 'var(--text-1)' }}>
                            {recipeId ? `✏️ ${name || 'Sin nombre'}` : '🆕 Nueva Ficha Técnica'}
                        </p>
                        {recipeId && <p className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>ID {recipeId}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={reset} className="btn-ghost text-xs">✕ Limpiar</button>
                        <button onClick={save} className="btn-success px-5 py-2">
                            {recipeId ? '💾 Actualizar' : '💾 Guardar receta'}
                        </button>
                    </div>
                </div>

                {/* Ficha */}
                <div className="card overflow-hidden">
                    {/* Info */}
                    <div className="px-5 py-4" style={{ background: 'var(--card-2)', borderBottom: '1px solid var(--border)' }}>
                        <div className="flex flex-col md:flex-row md:items-end gap-4">
                            <div className="flex-1">
                                <label className="label">Nombre del producto</label>
                                <input value={name} onChange={e => setName(e.target.value)} placeholder="Ej. Tarta de Frambuesa"
                                    className="w-full bg-transparent border-0 border-b-2 outline-none pb-1 text-xl font-bold placeholder:font-normal focus:border-indigo-500 transition-colors"
                                    style={{ color: 'var(--text-1)', borderColor: 'var(--border)', fontFamily: 'Inter' }} />
                            </div>
                            <div className="flex items-end gap-5">
                                <div>
                                    <label className="label">Rendimiento (Uni)</label>
                                    <input type="number" min="1" value={yld} onChange={e => setYld(parseFloat(e.target.value) || 1)}
                                        className="input w-24 text-center text-lg font-bold" style={{ color: 'var(--accent)' }} />
                                </div>
                                <div className="text-right">
                                    <p className="label mb-0.5">Costo total lote</p>
                                    <p className="price-display text-lg font-bold" style={{ color: 'var(--text-1)' }}>{formatCLP(totalBatch)}</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Ingredientes */}
                    <div className="overflow-x-auto">
                        <table className="tbl">
                            <thead><tr><th>Ingrediente</th><th className="w-24">Cant.</th><th className="w-20">Uni.</th><th className="w-32">$/Uni</th><th className="text-right">Total</th><th className="w-10"></th></tr></thead>
                            <tbody>
                                {ings.length === 0 && (
                                    <tr><td colSpan={6} className="py-8 text-center text-sm" style={{ color: 'var(--text-3)' }}>
                                        Sin ingredientes. Agrega uno abajo.
                                    </td></tr>
                                )}
                                {ings.map(ing => (
                                    <tr key={ing.id}>
                                        <td>
                                            <input list="catalog-list" value={ing.name} onChange={e => handleIngName(ing.id, e.target.value)} placeholder="Nombre..." className="input-sm w-full" />
                                        </td>
                                        <td><input type="number" value={ing.quantity} onChange={e => updateIng(ing.id, 'quantity', parseFloat(e.target.value) || 0)} className="input-sm w-full" /></td>
                                        <td><input type="text" value={ing.unit} onChange={e => updateIng(ing.id, 'unit', e.target.value)} className="input-sm w-full" /></td>
                                        <td><input type="number" value={ing.pricePerUnit} onChange={e => updateIng(ing.id, 'pricePerUnit', parseFloat(e.target.value) || 0)} className="input-sm w-full" /></td>
                                        <td className="text-right price-display text-xs" style={{ color: 'var(--text-2)' }}>{formatCLP(ing.quantity * ing.pricePerUnit)}</td>
                                        <td><button onClick={() => setIngs(p => p.filter(i => i.id !== ing.id))} className="btn-danger mx-auto block">×</button></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <button onClick={addIng} className="w-full py-3 text-sm font-semibold transition-colors hover:opacity-80" style={{ color: 'var(--accent)', borderTop: '1px solid var(--border)' }}>
                        + Agregar ingrediente
                    </button>
                </div>

                <button onClick={save} className="btn-success w-full py-4 text-base rounded-2xl shadow-card-lg">
                    {recipeId ? '💾 Actualizar receta' : '💾 Guardar receta en base de datos'}
                </button>
            </div>

            {/* Panel de costos */}
            <div className="xl:col-span-4">
                <div className="rounded-2xl overflow-hidden sticky top-20" style={{ background: 'linear-gradient(160deg, #1e1b4b 0%, #312e81 60%, #1e1b4b 100%)' }}>
                    <div className="px-5 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                        <p className="font-bold text-white">Estructura de Costo Unitario</p>
                        <p className="text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.5)' }}>Para {yld} unidad(es)</p>
                    </div>

                    <div className="px-5 py-3 space-y-0.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                        <SettingRow label="Make Up / Seguridad" stateKey="safetyFactor" suffix="%" />
                        <SettingRow label="Mano de obra (lote)" stateKey="laborCost" suffix="$" />
                        <SettingRow label="Packaging (lote)" stateKey="packagingCost" suffix="$" />
                    </div>

                    <div className="px-5 py-4 space-y-0.5">
                        <div className="flex items-end justify-between mb-3">
                            <div>
                                <p className="text-xs font-bold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.5)' }}>Costo neto unitario</p>
                                <p className="text-xs" style={{ color: 'rgba(255,255,255,0.3)' }}>(total lote / {yld})</p>
                            </div>
                            <span className="price-display text-2xl font-bold text-white">{formatCLP(unitCost)}</span>
                        </div>

                        <div className="flex items-center justify-between py-1.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                            <div className="flex items-center gap-2">
                                <span className="text-sm" style={{ color: 'rgba(255,255,255,0.6)' }}>Margen objetivo</span>
                                <input type="number" value={settings.targetMargin} onChange={e => setSettings({ ...settings, targetMargin: parseFloat(e.target.value) || 0 })}
                                    className="w-14 h-7 text-right text-xs text-white border-none rounded-md outline-none focus:ring-1 focus:ring-indigo-400"
                                    style={{ background: 'rgba(255,255,255,0.08)' }} />
                                <span className="text-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>%</span>
                            </div>
                            <span className="price-display text-sm font-semibold text-white">+ {formatCLP(profit)}</span>
                        </div>

                        <CostRow label="IVA (19%)" value={`+ ${formatCLP(tax)}`} />

                        <div className="flex items-center justify-between py-1.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                            <div className="flex items-center gap-2">
                                <span className="text-sm" style={{ color: 'rgba(255,255,255,0.6)' }}>Comisión GetNet</span>
                                <input type="number" step="0.01" value={settings.bankFee} onChange={e => setSettings({ ...settings, bankFee: parseFloat(e.target.value) || 0 })}
                                    className="w-14 h-7 text-right text-xs text-white border-none rounded-md outline-none focus:ring-1 focus:ring-indigo-400"
                                    style={{ background: 'rgba(255,255,255,0.08)' }} />
                                <span className="text-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>%</span>
                            </div>
                            <span className="price-display text-sm font-semibold text-white">+ {formatCLP(bankFee)}</span>
                        </div>

                        {/* Precio sugerido */}
                        <div className="mt-4 pt-1">
                            <p className="text-xs font-bold uppercase tracking-wider text-center mb-2" style={{ color: 'rgba(255,255,255,0.4)' }}>Precio de venta sugerido</p>
                            <div className="rounded-xl py-4 text-center" style={{ background: 'rgba(99,102,241,0.4)', border: '1px solid rgba(99,102,241,0.5)' }}>
                                <span className="price-display text-3xl font-extrabold text-white">{formatCLP(finalPrice)}</span>
                            </div>
                        </div>

                        {/* Precio real */}
                        <div className="mt-3">
                            <p className="text-xs font-bold uppercase tracking-wider text-center mb-2" style={{ color: 'rgba(52,211,153,0.6)' }}>Precio de venta real</p>
                            <div className="rounded-xl p-1" style={{ background: 'rgba(16,185,129,0.2)', border: '1px solid rgba(16,185,129,0.3)' }}>
                                <input type="number" value={realPrice || ''} onChange={e => setRealPrice(parseFloat(e.target.value) || 0)} placeholder="$ 0"
                                    className="w-full bg-transparent border-none text-center text-2xl font-bold outline-none text-emerald-300 placeholder:text-emerald-700 focus:ring-0 price-display" />
                            </div>
                            {realPrice > 0 && (
                                <div className="text-center mt-2">
                                    <p className="text-sm">
                                        Margen real:{' '}
                                        <span className={`font-bold price-display ${realMg >= settings.targetMargin ? 'text-emerald-400' : 'text-red-400'}`}>
                                            {realMg.toFixed(1)}%
                                        </span>
                                        {realMg < settings.targetMargin && <span className="ml-1">⚠️</span>}
                                    </p>
                                    <p className="text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.35)' }}>Ingreso neto: {formatCLP(realNet)}</p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

// ─────────────────────────────────────────────
// APP ROOT
// ─────────────────────────────────────────────
const App = () => {
    const [appState, setAppState] = useState<AppState>('loading');
    const [authScreen, setAuthScreen] = useState<AuthScreen>('login');
    const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
    const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('dolce_theme') as Theme) || 'light');
    const [activeTab, setActiveTab] = useState<ActiveTab>('calculator');
    const [recipes, setRecipes] = useState<SavedRecipe[]>([]);
    const [catalog, setCatalog] = useState<IngredientMaster[]>([]);
    const recipesHydrated = useRef(false);
    const catalogHydrated = useRef(false);
    const [editingRecipe, setEditingRecipe] = useState<SavedRecipe | null>(null);
    const [toasts, setToasts] = useState<Toast[]>([]);
    const toastId = useRef(0);

    const recipesKey = currentUser ? `dolce_recipes_${currentUser.id}` : 'dolce_recipes_anon';
    const catalogKey = currentUser ? `dolce_ingredients_${currentUser.id}` : 'dolce_ingredients_anon';

    const loadProfile = useCallback(async (userId: string, email: string) => {
        try {
            const { data: p } = await supabase.from('users').select('first_name,business_name').eq('id', userId).single();
            setCurrentUser({ id: userId, email, firstName: p?.first_name, businessName: p?.business_name });
        } catch { setCurrentUser({ id: userId, email }); }
        setAppState('app');
    }, []);

    useEffect(() => {
        const initAuth = async () => {
            const hash = window.location.hash;
            const params = new URLSearchParams(hash.replace('#', ''));

            // Check if there's an error from Supabase (e.g., otp_expired)
            if (params.get('error') || params.get('error_code')) {
                setAppState('reset-password');
                return;
            }

            // Check if this is a password recovery link from Supabase
            if (params.get('type') === 'recovery' || (params.get('access_token') && params.get('type') !== 'signup')) {
                setAppState('reset-password');
                return;
            }

            // Normal auth flow
            const { data: { session } } = await supabase.auth.getSession();
            if (session?.user) {
                loadProfile(session.user.id, session.user.email!);
            } else {
                setAppState('auth');
            }
        };

        initAuth();

        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
            if (event === 'PASSWORD_RECOVERY') {
                setAppState('reset-password');
            }
            else if (event === 'SIGNED_OUT') {
                setCurrentUser(null);
                setRecipes([]);
                setCatalog([]);
                setAppState('auth');
            }
            else if (event === 'SIGNED_IN' && session?.user) {
                if (appState !== 'reset-password') {
                    loadProfile(session.user.id, session.user.email!);
                }
            }
        });

        return () => subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!currentUser) return;
        const loadData = async () => {
            try {
                const { data: recipeData, error: recipeError } = await supabase.from('recipes').select('*').eq('user_id', currentUser.id);
                if (!recipeError && recipeData) {
                    setRecipes(recipeData.map((row: any) => ({
                        id: row.id,
                        name: row.name,
                        yield: row.yield,
                        ingredients: row.ingredients,
                        settings: row.settings,
                        finalPrice: row.final_price,
                        realPrice: row.real_price,
                        lastUpdated: row.last_updated
                    })));
                } else {
                    setRecipes([]);
                }
            } catch { setRecipes([]); }
            finally { recipesHydrated.current = true; }

            try {
                const { data, error } = await supabase.from('ingredient_catalog').select('*').eq('user_id', currentUser.id);
                if (!error && data) {
                    setCatalog(data.map((row: any) => ({
                        id: row.id,
                        name: row.name,
                        displayName: row.display_name,
                        unit: row.unit,
                        quantity: row.quantity || 1,
                        pricePerUnit: row.price_per_unit,
                        lastUpdated: row.last_updated
                    })));
                } else {
                    setCatalog([]);
                }
            } catch { setCatalog([]); }
            finally { catalogHydrated.current = true; }
        };
        loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentUser?.id]);

    useEffect(() => {
        if (!currentUser || !recipesHydrated.current) return;
        const rows = recipes.map(r => ({
            id: r.id,
            user_id: currentUser.id,
            name: r.name,
            yield: r.yield,
            ingredients: r.ingredients,
            settings: r.settings,
            final_price: r.finalPrice,
            real_price: r.realPrice,
            last_updated: r.lastUpdated
        }));
        if (rows.length === 0) return;
        supabase.from('recipes').upsert(rows).then(({ error }) => {
            if (error) console.error('[saveRecipes] upsert error:', error);
        });
    }, [recipes, currentUser]); // eslint-disable-line

    useEffect(() => {
        if (!currentUser || !catalogHydrated.current) return;
        const rows = catalog.map(item => ({
            id: item.id,
            user_id: currentUser.id,
            name: item.name,
            display_name: item.displayName,
            unit: item.unit,
            quantity: item.quantity,
            price_per_unit: item.pricePerUnit,
            last_updated: item.lastUpdated
        }));
        if (rows.length === 0) return;
        supabase.from('ingredient_catalog').upsert(rows).then(({ error }) => {
            if (error) console.error('[saveCatalog] upsert error:', error);
        });
    }, [catalog, currentUser]); // eslint-disable-line

    useEffect(() => {
        document.documentElement.classList.toggle('dark', theme === 'dark');
        localStorage.setItem('dolce_theme', theme);
    }, [theme]);

    const addToast = useCallback((message: string, type: ToastType = 'success') => {
        const id = ++toastId.current;
        setToasts(prev => [...prev, { id, message, type }]);
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
    }, []);

    const handleSave = useCallback((r: SavedRecipe) => {
        setRecipes(prev => { const i = prev.findIndex(x => x.id === r.id); return i >= 0 ? prev.map((x, j) => j === i ? r : x) : [...prev, r]; });
        setCatalog(prev => syncCatalog(r.ingredients, prev, r.lastUpdated));
        setEditingRecipe(null);
        addToast(`"${r.name}" guardada`, 'success');
    }, [addToast]);

    const handleDelete = useCallback(async (id: string) => {
        const r = recipes.find(x => x.id === id);
        if (!r || !confirm(`¿Eliminar "${r.name}"?`)) return;
        setRecipes(prev => prev.filter(x => x.id !== id));
        addToast(`"${r.name}" eliminada`, 'info');
        if (currentUser) {
            const { error } = await supabase.from('recipes').delete().eq('id', id).eq('user_id', currentUser.id);
            if (error) console.error('[handleDelete] error deleting recipe:', error);
        }
    }, [recipes, addToast, currentUser]);

    const handleEdit = useCallback((r: SavedRecipe) => { setEditingRecipe(r); setActiveTab('calculator'); addToast(`Editando "${r.name}"`, 'info'); }, [addToast]);

    const handleBatch = useCallback((updated: SavedRecipe[]) => {
        setRecipes(updated);
        if (editingRecipe) { const u = updated.find(r => r.id === editingRecipe.id); if (u) setEditingRecipe(u); }
    }, [editingRecipe]);

    const handleImport = useCallback((imported: SavedRecipe[]) => {
        setRecipes(imported);
        let cat: IngredientMaster[] = [];
        for (const r of imported) cat = syncCatalog(r.ingredients, cat, r.lastUpdated);
        setCatalog(prev => { const m = [...prev]; for (const e of cat) { const i = m.findIndex(c => c.name === e.name); if (i < 0) m.push(e); else if (m[i].lastUpdated < e.lastUpdated) m[i] = e; } return m; });
    }, []);

    const handleSignOut = useCallback(async () => { await supabase.auth.signOut(); setCurrentUser(null); setRecipes([]); setCatalog([]); setAppState('auth'); setAuthScreen('login'); }, []);

    // ── Auth screens ──
    if (appState === 'loading') return (
        <div className="min-h-screen flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)' }}>
            <div className="text-center text-white">
                <div className="text-6xl mb-4" style={{ animation: 'spin 2s linear infinite' }}>🍬</div>
                <p className="text-sm" style={{ color: 'rgba(165,180,252,0.8)' }}>Cargando...</p>
            </div>
        </div>
    );

    if (appState === 'auth') return authScreen === 'login'
        ? <LoginScreen onLogin={u => { setCurrentUser(u); setAppState('app'); }} onGoRegister={() => setAuthScreen('register')} />
        : <RegisterScreen onRegister={u => { setCurrentUser(u); setAppState('app'); }} onGoLogin={() => setAuthScreen('login')} />;

    if (appState === 'reset-password') return (
        <ResetPasswordScreen onDone={() => supabase.auth.getUser().then(({ data }) => { if (data.user) loadProfile(data.user.id, data.user.email!); else setAppState('auth'); })} />
    );

    // ── Main app ──
    const tabs = [
        { id: 'insumos' as ActiveTab, label: 'Insumos', emoji: '📦' },
        { id: 'calculator' as ActiveTab, label: 'Calculadora', emoji: '🧮' },
        { id: 'database' as ActiveTab, label: `Recetas${recipes.length ? ` (${recipes.length})` : ''}`, emoji: '📋' },
    ];

    return (
        <div className="min-h-screen" style={{ background: 'var(--page-bg)', color: 'var(--text-1)', fontFamily: 'Inter, system-ui, sans-serif' }}>
            {/* Navbar */}
            <nav style={{ background: 'var(--nav-bg)', borderBottom: '1px solid var(--nav-border)' }} className="sticky top-0 z-40">
                <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
                    {/* Logo */}
                    <div className="flex items-center gap-2 font-extrabold text-lg tracking-tight" style={{ color: 'var(--nav-text)' }}>
                        <span>🍬</span>
                        <span className="hidden sm:inline">DolceCostos</span>
                    </div>

                    {/* Tabs */}
                    <div className="flex items-center gap-1">
                        {tabs.map(t => (
                            <button key={t.id} onClick={() => { setActiveTab(t.id); if (t.id !== 'calculator') setEditingRecipe(null); }}
                                className={`nav-tab ${activeTab === t.id ? 'active' : ''}`}>
                                <span className="hidden sm:inline">{t.emoji}</span>
                                <span>{t.label}</span>
                            </button>
                        ))}
                    </div>

                    {/* Right controls */}
                    <div className="flex items-center gap-2">
                        {/* Theme toggle */}
                        <button onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
                            className="w-9 h-9 rounded-lg flex items-center justify-center transition-colors text-lg hover:bg-white/10"
                            style={{ color: 'var(--nav-muted)' }}
                            title={theme === 'dark' ? 'Modo claro' : 'Modo oscuro'}>
                            {theme === 'dark' ? '☀️' : '🌙'}
                        </button>

                        {/* User */}
                        <div className="flex items-center gap-2 pl-2" style={{ borderLeft: '1px solid var(--nav-border)' }}>
                            <div className="hidden md:block text-right leading-none">
                                <p className="text-xs font-semibold" style={{ color: 'var(--nav-text)' }}>
                                    {currentUser?.firstName || currentUser?.email?.split('@')[0]}
                                </p>
                                {currentUser?.businessName && (
                                    <p className="text-xs mt-0.5" style={{ color: 'var(--nav-muted)' }}>{currentUser.businessName}</p>
                                )}
                            </div>
                            <button onClick={handleSignOut} className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-white/10" style={{ color: 'var(--nav-muted)' }} title="Cerrar sesión">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </nav>

            {/* Content */}
            <main className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
                {activeTab === 'calculator' && <CalculatorTab initialRecipe={editingRecipe} catalog={catalog} onSave={handleSave} addToast={addToast} />}
                {activeTab === 'database' && <DatabaseTab recipes={recipes} onEdit={handleEdit} onDelete={handleDelete} onImport={handleImport} addToast={addToast} />}
                {activeTab === 'insumos' && <InsumosCatalogTab catalog={catalog} recipes={recipes} currentUser={currentUser} onCatalogChange={setCatalog} onBatchUpdateRecipes={handleBatch} addToast={addToast} />}
            </main>

            <ToastContainer toasts={toasts} onRemove={id => setToasts(p => p.filter(t => t.id !== id))} />
        </div>
    );
};

createRoot(document.getElementById('app')!).render(<App />);
