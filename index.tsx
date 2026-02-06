import React, { useState, useRef, useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";

// --- Tipos y Constantes ---

type Ingredient = {
    id: string;
    name: string;
    quantity: number;
    unit: string;
    pricePerUnit: number;
};

type CostSettings = {
    safetyFactor: number; // 3% Make Up
    laborCost: number; // Mano de Obra (Total Receta)
    packagingCost: number; // Packaging (Total Receta)
    targetMargin: number; // Margen %
    taxRate: number; // IVA 19%
    bankFee: number; // GET NET %
};

type SavedRecipe = {
    id: string;
    name: string;
    yield: number;
    ingredients: Ingredient[];
    settings: CostSettings;
    lastUpdated: number;
    finalPrice: number;
    realPrice?: number;
};

const DEFAULT_SETTINGS: CostSettings = {
    safetyFactor: 3,
    laborCost: 1500,
    packagingCost: 500,
    targetMargin: 30,
    taxRate: 19,
    bankFee: 2.95,
};

// --- Helper Functions ---

const fileToGenerativePart = async (file: File): Promise<{ inlineData: { data: string; mimeType: string } }> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const base64String = reader.result as string;
            const base64Data = base64String.split(',')[1];
            resolve({
                inlineData: {
                    data: base64Data,
                    mimeType: file.type,
                },
            });
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
};

const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' }).format(amount);
};

// Formats a number string "1200" to "1.200" for display
const formatNumberWithDots = (value: string | number): string => {
    if (value === '' || value === undefined || value === null) return '';
    const raw = value.toString().replace(/\D/g, '');
    return raw.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
};

// Parses "1.200" back to 1200 for calculation
const parseNumberFromDots = (value: string): number => {
    return parseInt(value.replace(/\./g, ''), 10) || 0;
};

// Helper for CSV Parsing (handles quoted strings with commas)
const parseCSVLine = (text: string): string[] => {
    const result = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '"') {
            inQuote = !inQuote;
        } else if (char === ',' && !inQuote) {
            result.push(cur);
            cur = '';
        } else {
            cur += char;
        }
    }
    result.push(cur);
    // Remove surrounding quotes if present
    return result.map(s => s.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
};

// Centralized Calculation Logic
const recalculateRecipeCosts = (recipe: SavedRecipe): SavedRecipe => {
    const settings = recipe.settings;
    const batchIngredientsCost = recipe.ingredients.reduce((sum, i) => sum + (i.quantity * i.pricePerUnit), 0);
    const batchSafetyCost = batchIngredientsCost * (settings.safetyFactor / 100);
    const batchTotalBase = batchIngredientsCost + batchSafetyCost;
    const totalBatchCost = batchTotalBase + settings.laborCost + settings.packagingCost;
    const totalUnitCost = recipe.yield > 0 ? totalBatchCost / recipe.yield : 0;

    const validMargin = Math.min(Math.max(settings.targetMargin, 0), 99);
    const priceBeforeTax = totalUnitCost / (1 - (validMargin / 100));

    const taxAmount = priceBeforeTax * (settings.taxRate / 100);
    const priceWithTax = priceBeforeTax + taxAmount;
    const bankFeeAmount = priceWithTax * (settings.bankFee / 100);
    const finalPrice = priceWithTax + bankFeeAmount;

    return {
        ...recipe,
        finalPrice
    };
};

const calculateRealMargin = (recipe: SavedRecipe): number => {
    if (!recipe.realPrice || recipe.realPrice <= 0) return 0;

    // Costo Unitario
    const batchIng = recipe.ingredients.reduce((s, i) => s + (i.quantity * i.pricePerUnit), 0);
    const batchSafety = batchIng * (recipe.settings.safetyFactor / 100);
    const totalBatch = batchIng + batchSafety + recipe.settings.laborCost + recipe.settings.packagingCost;
    const unitCost = recipe.yield > 0 ? totalBatch / recipe.yield : 0;

    // Ingreso Neto Real (Quitando IVA y Comisión del precio de venta real)
    const netIncome = recipe.realPrice / (1 + (recipe.settings.bankFee / 100)) / (1 + (recipe.settings.taxRate / 100));

    if (netIncome <= 0) return 0;
    return ((netIncome - unitCost) / netIncome) * 100;
};

// --- Components ---

/**
 * Componente: Matriz de Precios Inteligente (Antes Analyzer)
 */
const PriceMatrixTab = ({
    recipes,
    onBatchUpdate
}: {
    recipes: SavedRecipe[],
    onBatchUpdate: (updatedRecipes: SavedRecipe[]) => void
}) => {
    const [contextText, setContextText] = useState('');
    const [images, setImages] = useState<File[]>([]);
    const [analyzing, setAnalyzing] = useState(false);
    const [aiResult, setAiResult] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const [ingredientMap, setIngredientMap] = useState<Map<string, { currentPrice: number, count: number }>>(new Map());
    const [editedPrices, setEditedPrices] = useState<Record<string, string>>({});
    const [searchTerm, setSearchTerm] = useState('');

    // 1. Extraer ingredientes únicos al cargar o cambiar recetas
    useEffect(() => {
        const map = new Map<string, { currentPrice: number, count: number }>();
        recipes.forEach(r => {
            r.ingredients.forEach(i => {
                const normalizedName = i.name.trim();
                if (!map.has(normalizedName)) {
                    map.set(normalizedName, { currentPrice: i.pricePerUnit, count: 1 });
                } else {
                    const entry = map.get(normalizedName)!;
                    map.set(normalizedName, { ...entry, count: entry.count + 1 });
                }
            });
        });
        setIngredientMap(map);
    }, [recipes]);

    const handlePriceChange = (name: string, value: string) => {
        const rawValue = value.replace(/\D/g, '');
        setEditedPrices(prev => {
            if (rawValue === '') {
                const next = { ...prev };
                delete next[name];
                return next;
            }
            return { ...prev, [name]: formatNumberWithDots(rawValue) };
        });
    };

    const applyChanges = () => {
        const updates = Object.keys(editedPrices);
        if (updates.length === 0) return;

        if (!confirm(`Se actualizarán precios para ${updates.length} insumos en todas las recetas vinculadas. Los costos y precios sugeridos se recalcularán. ¿Continuar?`)) return;

        let updatedRecipeCount = 0;

        const updatedRecipes = recipes.map(recipe => {
            let hasChanges = false;
            const newIngredients = recipe.ingredients.map(ing => {
                const normalizedName = ing.name.trim();
                const formattedNewPrice = editedPrices[normalizedName];

                if (formattedNewPrice !== undefined) {
                    const newPrice = parseNumberFromDots(formattedNewPrice);
                    // Comparar valor para ver si cambia
                    if (!isNaN(newPrice) && Math.abs(newPrice - ing.pricePerUnit) > 0.01) {
                        hasChanges = true;
                        return { ...ing, pricePerUnit: newPrice };
                    }
                }
                return ing;
            });

            if (hasChanges) {
                updatedRecipeCount++;
                return recalculateRecipeCosts({
                    ...recipe,
                    ingredients: newIngredients,
                    lastUpdated: Date.now()
                });
            }
            return recipe;
        });

        onBatchUpdate(updatedRecipes);
        setEditedPrices({});
        alert(`¡Éxito! Se actualizaron ${updatedRecipeCount} recetas y se recalcularon los costos.`);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            applyChanges();
        }
    };

    const handleAnalyze = async () => {
        if (!process.env.API_KEY) { alert("API Key missing"); return; }
        setAnalyzing(true);
        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            const imageParts = await Promise.all(images.map(fileToGenerativePart));

            const prompt = `Analiza estas facturas/imágenes. 
      Devuelve SOLO una lista JSON con los ingredientes detectados y su precio unitario estimado.
      Formato esperado: [{ "name": "Harina", "price": 1200 }, { "name": "Azucar", "price": 900 }]`;

            const response = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                config: { responseMimeType: "application/json" },
                contents: { parts: [...imageParts, { text: prompt + (contextText ? ` Contexto: ${contextText}` : '') }] }
            });

            const cleanText = response.text?.replace(/```json|```/g, '').trim();
            setAiResult(cleanText || "[]");
        } catch (error) {
            alert(`Error IA: ${(error as Error).message}`);
        } finally {
            setAnalyzing(false);
        }
    };

    const uniqueIngredients = Array.from(ingredientMap.entries())
        .map(([name, data]) => ({ name, ...data }))
        .filter(i => i.name.toLowerCase().includes(searchTerm.toLowerCase()))
        .sort((a, b) => b.count - a.count);

    return (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            <div className="lg:col-span-8 space-y-6">
                <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
                    <div className="flex flex-col md:flex-row justify-between items-center mb-6 gap-4">
                        <div>
                            <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
                                <svg className="w-6 h-6 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 7h6m0 3.666V3m6 18c0-.55-.45-1-1-1h-2.667c-1.103 0-1.543.513-1.637.56L10 16.142M6 21h12a1 1 0 001-1v-2a1 1 0 00-1-1h-2.293a1 1 0 00-.707.293l-1.414 1.414a1 1 0 01-1.414 0L9.293 16.707a1 1 0 00-.707-.293H6a1 1 0 00-1 1v2a1 1 0 001 1z"></path></svg>
                                Matriz de Insumos
                            </h2>
                            <p className="text-sm text-slate-500">Cambia precios aquí. Formato automático (ej: escribe 4500 → 4.500)</p>
                        </div>
                        <div className="flex gap-2 w-full md:w-auto">
                            <input
                                type="text"
                                placeholder="Buscar insumo..."
                                className="border border-slate-300 rounded-lg px-3 py-2 text-sm w-full"
                                value={searchTerm}
                                onChange={e => setSearchTerm(e.target.value)}
                            />
                            {Object.keys(editedPrices).length > 0 && (
                                <button
                                    onClick={applyChanges}
                                    className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg font-bold text-sm shadow animate-pulse whitespace-nowrap"
                                >
                                    Aplicar Cambios ({Object.keys(editedPrices).length})
                                </button>
                            )}
                        </div>
                    </div>

                    <div className="overflow-hidden rounded-lg border border-slate-200">
                        <table className="w-full text-sm text-left">
                            <thead className="bg-slate-100 text-slate-600 font-bold uppercase text-xs">
                                <tr>
                                    <th className="px-4 py-3">Insumo (Nombre Exacto)</th>
                                    <th className="px-4 py-3 text-center">Uso en Recetas</th>
                                    <th className="px-4 py-3">Precio Actual ($/Uni)</th>
                                    <th className="px-4 py-3 bg-indigo-50 text-indigo-700">Nuevo Precio</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {uniqueIngredients.length === 0 ? (
                                    <tr><td colSpan={4} className="p-4 text-center text-slate-400">No hay insumos registrados.</td></tr>
                                ) : (
                                    uniqueIngredients.map((ing) => (
                                        <tr key={ing.name} className="hover:bg-slate-50">
                                            <td className="px-4 py-3 font-medium text-slate-800">{ing.name}</td>
                                            <td className="px-4 py-3 text-center">
                                                <span className="bg-slate-200 text-slate-700 px-2 py-1 rounded-full text-xs font-bold">{ing.count}</span>
                                            </td>
                                            <td className="px-4 py-3 font-mono text-slate-600">{formatCurrency(ing.currentPrice)}</td>
                                            <td className="px-4 py-2 bg-indigo-50/50">
                                                <div className="relative">
                                                    <span className="absolute left-2 top-1.5 text-slate-400 font-mono text-sm">$</span>
                                                    <input
                                                        type="text"
                                                        inputMode="numeric"
                                                        autoComplete="off"
                                                        placeholder={formatNumberWithDots(ing.currentPrice)}
                                                        value={editedPrices[ing.name] || ''}
                                                        className={`w-full border rounded pl-6 pr-2 py-1 font-mono font-bold ${editedPrices[ing.name] ? 'border-green-500 bg-green-50 text-green-700' : 'border-slate-300 text-slate-800'}`}
                                                        onChange={(e) => handlePriceChange(ing.name, e.target.value)}
                                                        onKeyDown={handleKeyDown}
                                                    />
                                                </div>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <div className="lg:col-span-4 space-y-6">
                <div className="bg-indigo-900 text-white p-6 rounded-xl shadow-lg">
                    <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-indigo-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                        Asistente de Facturas
                    </h3>
                    <p className="text-sm text-indigo-200 mb-4">Sube una foto de tu factura y la IA detectará los precios para que puedas copiarlos a la matriz.</p>

                    <div className="space-y-3">
                        <div className="grid grid-cols-3 gap-2">
                            {images.map((img, idx) => (
                                <div key={idx} className="relative aspect-square rounded overflow-hidden border border-indigo-500">
                                    <img src={URL.createObjectURL(img)} className="w-full h-full object-cover" />
                                </div>
                            ))}
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                className="aspect-square border-2 border-dashed border-indigo-400 rounded flex flex-col items-center justify-center text-indigo-300 hover:text-white hover:border-white transition-colors"
                            >
                                <span className="text-2xl">+</span>
                            </button>
                        </div>
                        <input type="file" multiple accept="image/*" ref={fileInputRef} className="hidden" onChange={(e) => e.target.files && setImages([...images, ...Array.from(e.target.files)])} />

                        <button
                            onClick={handleAnalyze}
                            disabled={analyzing}
                            className="w-full py-2 bg-indigo-500 hover:bg-indigo-400 rounded-lg font-bold text-sm transition-colors disabled:opacity-50"
                        >
                            {analyzing ? 'Analizando...' : 'Escanear Precios'}
                        </button>
                    </div>

                    {aiResult && (
                        <div className="mt-4 pt-4 border-t border-indigo-700">
                            <h4 className="text-xs font-bold uppercase text-indigo-300 mb-2">Precios Detectados:</h4>
                            <div className="bg-indigo-800 rounded p-2 text-xs font-mono max-h-48 overflow-auto">
                                {(() => {
                                    try {
                                        const parsed = JSON.parse(aiResult);
                                        return Array.isArray(parsed) ? (
                                            <ul className="space-y-1">
                                                {parsed.map((item: any, i: number) => (
                                                    <li key={i} className="flex justify-between">
                                                        <span>{item.name}</span>
                                                        <span className="text-green-300">${item.price}</span>
                                                    </li>
                                                ))}
                                            </ul>
                                        ) : aiResult;
                                    } catch { return aiResult; }
                                })()}
                            </div>
                            <p className="text-[10px] text-indigo-300 mt-2 italic">Copia estos valores manualmente en la tabla de la izquierda.</p>
                        </div>
                    )}
                </div>
            </div>

        </div>
    );
};

const DatabaseTab = ({
    recipes,
    onEdit,
    onDelete,
    onImport
}: {
    recipes: SavedRecipe[],
    onEdit: (r: SavedRecipe) => void,
    onDelete: (id: string) => void,
    onImport: (recipes: SavedRecipe[]) => void
}) => {
    const backupInputRef = useRef<HTMLInputElement>(null);
    const csvInputRef = useRef<HTMLInputElement>(null);
    const [searchTerm, setSearchTerm] = useState('');

    const handleExportCSV = () => {
        const headers = ["ID", "Nombre Receta", "Rendimiento", "Precio Final (Sugerido)", "Precio Real", "Margen Real %"];
        const rows = recipes.map(r => {
            const margin = calculateRealMargin(r).toFixed(2);
            return [
                r.id,
                `"${r.name.replace(/"/g, '""')}"`,
                r.yield,
                r.finalPrice,
                r.realPrice || 0,
                margin
            ].join(",");
        });

        const csvContent = "data:text/csv;charset=utf-8," + [headers.join(","), ...rows].join("\n");
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `dolce_db_hoja_calculo.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleImportCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (evt) => {
            const text = evt.target?.result as string;
            if (!text) return;
            const lines = text.split('\n');

            const updatedRecipes = [...recipes];
            let updateCount = 0;

            // Skip header (i=1)
            for (let i = 1; i < lines.length; i++) {
                if (!lines[i].trim()) continue;

                // Use robust parser
                const cols = parseCSVLine(lines[i]);
                if (cols.length < 5) continue;

                const id = cols[0];
                const realPrice = parseFloat(cols[4]);

                const idx = updatedRecipes.findIndex(r => r.id === id);
                if (idx >= 0 && !isNaN(realPrice)) {
                    updatedRecipes[idx] = {
                        ...updatedRecipes[idx],
                        realPrice: realPrice,
                        lastUpdated: Date.now()
                    };
                    updateCount++;
                }
            }

            if (updateCount > 0) {
                onImport(updatedRecipes);
                alert(`Se actualizaron ${updateCount} recetas desde el CSV.`);
            } else {
                alert("No se encontraron coincidencias o el archivo CSV no tiene el formato correcto.");
            }
        };
        reader.readAsText(file);
    };

    const handleExportJSON = () => {
        const dataStr = JSON.stringify(recipes, null, 2);
        const blob = new Blob([dataStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `dolce_full_backup.json`;
        link.click();
    };

    const handleFileImportJSON = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const result = event.target?.result;
                const rawImport = JSON.parse(result as string);
                if (!Array.isArray(rawImport)) throw new Error("Formato inválido");

                const sanitizedRecipes = rawImport.map((r: any) => ({
                    ...r,
                    settings: { ...DEFAULT_SETTINGS, ...(r.settings || {}) }
                }));

                if (confirm(`Restaurar ${sanitizedRecipes.length} recetas? (Reemplazará todo)`)) {
                    onImport(sanitizedRecipes);
                }
            } catch (error) {
                alert("Error archivo inválido.");
            }
        };
        reader.readAsText(file);
    };

    const filteredRecipes = recipes.filter(r => r.name.toLowerCase().includes(searchTerm.toLowerCase()));

    const totalRecipes = recipes.length;
    const validRecipesForMargin = recipes.filter(r => r.realPrice && r.realPrice > 0);
    const sumMargins = validRecipesForMargin.reduce((acc, r) => acc + calculateRealMargin(r), 0);
    const avgMargin = validRecipesForMargin.length > 0 ? sumMargins / validRecipesForMargin.length : 0;

    const totalValue = recipes.reduce((acc, r) => acc + (r.realPrice || r.finalPrice), 0);

    return (
        <div className="space-y-8">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex items-center gap-4">
                    <div className="p-3 bg-indigo-100 rounded-full text-indigo-600">
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
                    </div>
                    <div>
                        <p className="text-xs font-bold text-slate-500 uppercase">Recetas en DB</p>
                        <p className="text-2xl font-bold text-slate-800">{totalRecipes}</p>
                    </div>
                </div>
                <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex items-center gap-4">
                    <div className="p-3 bg-green-100 rounded-full text-green-600">
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    </div>
                    <div>
                        <p className="text-xs font-bold text-slate-500 uppercase">Margen Real Prom.</p>
                        <p className={`text-2xl font-bold ${avgMargin >= 30 ? 'text-green-600' : 'text-yellow-600'}`}>{avgMargin.toFixed(1)}%</p>
                    </div>
                </div>
                <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex items-center gap-4">
                    <div className="p-3 bg-blue-100 rounded-full text-blue-600">
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                    </div>
                    <div>
                        <p className="text-xs font-bold text-slate-500 uppercase">Valor Catálogo</p>
                        <p className="text-xl font-bold text-slate-800">{formatCurrency(totalValue)}</p>
                    </div>
                </div>
            </div>

            <div className="flex flex-col md:flex-row justify-between items-center gap-4 bg-white p-4 rounded-xl border border-slate-200">
                <div className="relative w-full md:w-96">
                    <input
                        type="text"
                        placeholder="Buscar receta por nombre..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
                    />
                    <svg className="w-5 h-5 text-slate-400 absolute left-3 top-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                </div>

                <div className="flex flex-wrap gap-2 w-full md:w-auto justify-end">
                    <button
                        onClick={handleExportCSV}
                        className="flex items-center gap-2 px-3 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-xs font-bold transition-colors"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                        Descargar CSV
                    </button>
                    <button
                        onClick={() => csvInputRef.current?.click()}
                        className="flex items-center gap-2 px-3 py-2 bg-green-50 hover:bg-green-100 text-green-700 border border-green-200 rounded-lg text-xs font-bold transition-colors"
                    >
                        Subir CSV
                    </button>
                    <input
                        type="file"
                        ref={csvInputRef}
                        onChange={handleImportCSV}
                        onClick={(e) => (e.currentTarget.value = '')}
                        accept=".csv"
                        className="hidden"
                    />

                    <div className="w-px h-8 bg-slate-300 mx-2"></div>

                    <button
                        onClick={handleExportJSON}
                        className="flex items-center gap-2 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-bold transition-colors"
                    >
                        Respaldo Full
                    </button>
                    <button
                        onClick={() => backupInputRef.current?.click()}
                        className="flex items-center gap-2 px-3 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-xs font-bold transition-colors"
                    >
                        Restaurar
                    </button>
                    <input
                        type="file"
                        ref={backupInputRef}
                        onChange={handleFileImportJSON}
                        onClick={(e) => (e.currentTarget.value = '')}
                        accept=".json"
                        className="hidden"
                    />
                </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <table className="w-full text-sm text-left border-collapse">
                    <thead className="bg-slate-100 text-slate-600 font-bold uppercase text-xs border-b border-slate-300">
                        <tr>
                            <th className="px-4 py-3 border-r border-slate-200">Nombre Receta</th>
                            <th className="px-2 py-3 text-center border-r border-slate-200 w-16">Uni.</th>
                            <th className="px-4 py-3 text-right border-r border-slate-200">Sugerido</th>
                            <th className="px-4 py-3 text-right border-r border-slate-200 text-indigo-700">Precio Real</th>
                            <th className="px-4 py-3 text-center border-r border-slate-200">Margen</th>
                            <th className="px-4 py-3 text-right">Acciones</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                        {filteredRecipes.length === 0 ? (
                            <tr>
                                <td colSpan={6} className="px-6 py-8 text-center text-slate-400 italic">
                                    No se encontraron recetas.
                                </td>
                            </tr>
                        ) : (
                            filteredRecipes.map((r) => {
                                const margin = calculateRealMargin(r);
                                const marginDisplay = margin.toFixed(1);

                                return (
                                    <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                                        <td className="px-4 py-2 font-medium text-slate-800 border-r border-slate-100">{r.name}</td>
                                        <td className="px-2 py-2 text-center text-slate-600 border-r border-slate-100">{r.yield}</td>
                                        <td className="px-4 py-2 text-right font-mono text-slate-500 border-r border-slate-100">{formatCurrency(r.finalPrice)}</td>
                                        <td className="px-4 py-2 text-right font-mono font-bold text-indigo-700 bg-indigo-50/30 border-r border-slate-100">
                                            {r.realPrice ? formatCurrency(r.realPrice) : <span className="text-slate-300">-</span>}
                                        </td>
                                        <td className="px-4 py-2 text-center border-r border-slate-100">
                                            {r.realPrice ? (
                                                <span className={`px-2 py-0.5 rounded text-xs font-bold ${margin >= r.settings.targetMargin ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                                                    {marginDisplay}%
                                                </span>
                                            ) : (
                                                <span className="text-slate-300 text-xs">-</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-2 text-right">
                                            <div className="flex justify-end gap-2">
                                                <button
                                                    onClick={() => onEdit(r)}
                                                    className="p-1.5 text-indigo-600 hover:bg-indigo-100 rounded transition-colors"
                                                    title="Editar"
                                                >
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                                                </button>
                                                <button
                                                    onClick={() => onDelete(r.id)}
                                                    className="p-1.5 text-red-400 hover:bg-red-100 rounded transition-colors"
                                                    title="Eliminar"
                                                >
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>

            <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 rounded-r-lg">
                <div className="flex">
                    <div className="flex-shrink-0">
                        <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                        </svg>
                    </div>
                    <div className="ml-3">
                        <p className="text-sm text-yellow-700">
                            <strong>Integración Excel/Sheets:</strong> Usa el botón "Descargar CSV" para bajar la tabla. Ábrela en Google Sheets, edita precios reales o nombres, guarda como CSV y usa "Subir CSV" para actualizar los datos aquí.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};

/**
 * Componente: Calculadora Ficha Técnica (Actualizado para Props)
 */
const CalculatorTab = ({
    initialRecipe,
    onSave
}: {
    initialRecipe?: SavedRecipe | null,
    onSave: (recipe: SavedRecipe) => void
}) => {
    const [recipeId, setRecipeId] = useState<string | null>(null);
    const [recipeName, setRecipeName] = useState('');
    const [recipeYield, setRecipeYield] = useState(1);
    const [ingredients, setIngredients] = useState<Ingredient[]>([]);
    const [settings, setSettings] = useState<CostSettings>(DEFAULT_SETTINGS);
    const [realPrice, setRealPrice] = useState<number>(0);

    const [importText, setImportText] = useState('');
    const [importing, setImporting] = useState(false);
    const recipeImageInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (initialRecipe) {
            setRecipeId(initialRecipe.id);
            setRecipeName(initialRecipe.name);
            setRecipeYield(initialRecipe.yield);
            setIngredients(initialRecipe.ingredients);
            setSettings(initialRecipe.settings);
            setRealPrice(initialRecipe.realPrice || 0);
        } else {
            // Reset only if strictly needed
        }
    }, [initialRecipe]);

    const handleReset = () => {
        setRecipeId(null);
        setRecipeName('');
        setRecipeYield(1);
        setIngredients([]);
        setSettings(DEFAULT_SETTINGS);
        setRealPrice(0);
    };

    const currentRecipeState: SavedRecipe = {
        id: recipeId || '',
        name: recipeName,
        yield: recipeYield,
        ingredients: ingredients,
        settings: settings,
        lastUpdated: 0,
        finalPrice: 0
    };

    const calculated = recalculateRecipeCosts(currentRecipeState);

    const batchIngredientsCost = ingredients.reduce((sum, i) => sum + (i.quantity * i.pricePerUnit), 0);
    const batchSafetyCost = batchIngredientsCost * (settings.safetyFactor / 100);
    const batchTotalBase = batchIngredientsCost + batchSafetyCost;
    const totalBatchCostDisplay = batchTotalBase + settings.laborCost + settings.packagingCost;
    const totalUnitCost = recipeYield > 0 ? totalBatchCostDisplay / recipeYield : 0;

    const priceBeforeTax = totalUnitCost / (1 - (settings.targetMargin / 100));
    const profitAmount = priceBeforeTax - totalUnitCost;
    const taxAmount = priceBeforeTax * (settings.taxRate / 100);
    const bankFeeAmount = (priceBeforeTax + taxAmount) * (settings.bankFee / 100);

    const realIngresoNeto = realPrice / (1 + (settings.bankFee / 100)) / (1 + (settings.taxRate / 100));
    const realMarginPercent = realIngresoNeto > 0 ? ((realIngresoNeto - totalUnitCost) / realIngresoNeto) * 100 : 0;

    const handleSave = () => {
        if (!recipeName.trim()) {
            alert("Por favor, asigna un nombre a la receta.");
            return;
        }
        const newRecipe: SavedRecipe = {
            ...currentRecipeState,
            id: recipeId || Date.now().toString(),
            lastUpdated: Date.now(),
            finalPrice: calculated.finalPrice,
            realPrice: realPrice > 0 ? realPrice : undefined
        };
        onSave(newRecipe);
        if (!recipeId) setRecipeId(newRecipe.id);
    };

    const addIngredient = () => {
        setIngredients([...ingredients, { id: Date.now().toString(), name: '', quantity: 0, unit: 'un', pricePerUnit: 0 }]);
    };

    const updateIngredient = (id: string, field: keyof Ingredient, value: any) => {
        setIngredients(prev => prev.map(ing => ing.id === id ? { ...ing, [field]: value } : ing));
    };

    const removeIngredient = (id: string) => {
        setIngredients(prev => prev.filter(ing => ing.id !== id));
    };

    const recipeResponseSchema = {
        type: Type.OBJECT,
        properties: {
            name: { type: Type.STRING },
            yield: { type: Type.NUMBER },
            ingredients: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        name: { type: Type.STRING },
                        quantity: { type: Type.NUMBER },
                        unit: { type: Type.STRING },
                        pricePerUnit: { type: Type.NUMBER }
                    }
                }
            }
        }
    };

    const applyRecipeData = (data: any) => {
        if (data.name) setRecipeName(data.name);
        if (data.yield) setRecipeYield(Number(data.yield) || 1);
        if (data.ingredients && Array.isArray(data.ingredients)) {
            const newIngredients = data.ingredients.map((item: any) => ({
                id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
                name: item.name || 'Ingrediente',
                quantity: Number(item.quantity) || 0,
                unit: item.unit || 'un',
                pricePerUnit: Number(item.pricePerUnit) || 0
            }));
            setIngredients(newIngredients);
        }
    };

    const handleImportRecipeText = async () => {
        if (!importText || !process.env.API_KEY) return;
        setImporting(true);
        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            const response = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: `Analiza este texto de receta. Extrae el nombre, rendimiento (porciones) y lista de ingredientes.
        Texto: "${importText}".`,
                config: { responseMimeType: "application/json", responseSchema: recipeResponseSchema }
            });
            const cleanText = response.text?.replace(/```json|```/g, '').trim();
            const data = JSON.parse(cleanText || "{}");
            applyRecipeData(data);
            setImportText('');
        } catch (e) {
            console.error(e);
            alert("Error importando receta: " + (e as Error).message);
        } finally {
            setImporting(false);
        }
    };

    const handleImportRecipeImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !process.env.API_KEY) return;
        setImporting(true);
        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            const imagePart = await fileToGenerativePart(file);
            const response = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: { parts: [imagePart, { text: "Analiza esta imagen de receta. Extrae el nombre, el rendimiento (cantidad de unidades/porciones que rinde) y los ingredientes. Si hay precios visibles, inclúyelos." }] },
                config: { responseMimeType: "application/json", responseSchema: recipeResponseSchema }
            });
            const cleanText = response.text?.replace(/```json|```/g, '').trim();
            const data = JSON.parse(cleanText || "{}");
            applyRecipeData(data);
        } catch (error) {
            console.error(error);
            alert("No se pudo procesar la imagen: " + (error as Error).message);
        } finally {
            setImporting(false);
            if (recipeImageInputRef.current) recipeImageInputRef.current.value = '';
        }
    };

    return (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 relative">
            <div className="xl:col-span-8 space-y-6">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white p-4 rounded-xl shadow-sm border border-slate-200">
                    <h3 className="font-bold text-lg text-slate-800">
                        {recipeId ? `Editando: ${recipeName}` : 'Nueva Ficha Técnica'}
                    </h3>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleReset}
                            className="text-slate-500 hover:text-indigo-600 px-3 py-2 text-sm font-bold"
                        >
                            Limpiar / Nueva
                        </button>
                        <button
                            onClick={handleSave}
                            className="bg-green-600 hover:bg-green-700 text-white px-6 py-2 rounded-lg font-bold text-sm shadow-sm transition-colors flex items-center gap-2"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"></path></svg>
                            {recipeId ? 'Actualizar Base de Datos' : 'Guardar en Base de Datos'}
                        </button>
                    </div>
                </div>

                <div className="bg-slate-800 text-white p-4 rounded-xl shadow-lg">
                    <h3 className="text-sm font-bold uppercase tracking-wider text-indigo-300 mb-3">✨ Asistente IA: Importar Receta</h3>
                    <div className="flex gap-2 mb-2">
                        <input
                            type="text"
                            value={importText}
                            onChange={(e) => setImportText(e.target.value)}
                            placeholder="Escribe: 'Lemon Pie para 12 pax, con 500g harina...'"
                            className="flex-1 bg-slate-700 border-none rounded text-sm text-white placeholder-slate-400 focus:ring-2 focus:ring-indigo-400"
                        />
                        <button
                            onClick={handleImportRecipeText}
                            disabled={importing}
                            className="bg-indigo-600 hover:bg-indigo-500 px-4 py-2 rounded text-sm font-bold transition-colors disabled:opacity-50"
                        >
                            {importing ? '...' : 'Importar Texto'}
                        </button>
                    </div>
                    <div className="flex items-center gap-3 pt-2 border-t border-slate-700">
                        <span className="text-xs text-slate-400">O también puedes:</span>
                        <input
                            type="file"
                            accept="image/*"
                            ref={recipeImageInputRef}
                            className="hidden"
                            onChange={handleImportRecipeImage}
                            onClick={(e) => (e.currentTarget.value = '')}
                        />
                        <button
                            onClick={() => recipeImageInputRef.current?.click()}
                            disabled={importing}
                            className="flex items-center gap-2 text-xs font-bold bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded text-white transition-colors"
                        >
                            <svg className="w-4 h-4 text-indigo-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"></path><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
                            Subir Foto de Receta
                        </button>
                    </div>
                </div>

                <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                    <div className="p-4 bg-slate-50 border-b border-slate-200">
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                            <div className="flex-1">
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Nombre Producto</label>
                                <input
                                    type="text"
                                    value={recipeName}
                                    onChange={e => setRecipeName(e.target.value)}
                                    placeholder="Ej. Tarta de Frambuesa"
                                    className="w-full bg-transparent border-b border-slate-300 p-1 text-xl font-bold text-slate-800 focus:ring-0 focus:border-indigo-500 placeholder-slate-300"
                                />
                            </div>
                            <div className="flex items-center gap-4">
                                <div className="w-32">
                                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Rendimiento (Uni)</label>
                                    <input
                                        type="number"
                                        min="1"
                                        value={recipeYield}
                                        onChange={e => setRecipeYield(parseFloat(e.target.value) || 1)}
                                        className="w-full border border-slate-300 rounded p-1 text-lg font-bold text-center text-indigo-700 focus:ring-indigo-500"
                                    />
                                </div>
                                <div className="text-right pl-4 border-l border-slate-200">
                                    <span className="block text-xs font-bold text-slate-500 uppercase">Costo Total Lote</span>
                                    <span className="text-lg font-mono font-bold text-slate-700">{formatCurrency(totalBatchCostDisplay)}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <table className="w-full text-sm text-left">
                        <thead className="bg-slate-100 text-slate-600 font-medium uppercase text-xs">
                            <tr>
                                <th className="px-4 py-3">Ingrediente</th>
                                <th className="px-4 py-3 w-24">Cant.</th>
                                <th className="px-4 py-3 w-20">Uni.</th>
                                <th className="px-4 py-3 w-32">$/Unit</th>
                                <th className="px-4 py-3 text-right">Total</th>
                                <th className="px-2 py-3 w-10"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {ingredients.map((ing) => (
                                <tr key={ing.id} className="hover:bg-slate-50">
                                    <td className="p-2">
                                        <input type="text" value={ing.name} onChange={e => updateIngredient(ing.id, 'name', e.target.value)} className="w-full border-slate-200 rounded text-sm py-1 text-slate-900" />
                                    </td>
                                    <td className="p-2">
                                        <input type="number" value={ing.quantity} onChange={e => updateIngredient(ing.id, 'quantity', parseFloat(e.target.value) || 0)} className="w-full border-slate-200 rounded text-sm py-1 text-slate-900" />
                                    </td>
                                    <td className="p-2">
                                        <input type="text" value={ing.unit} onChange={e => updateIngredient(ing.id, 'unit', e.target.value)} className="w-full border-slate-200 rounded text-sm py-1 text-slate-900" />
                                    </td>
                                    <td className="p-2">
                                        <input type="number" value={ing.pricePerUnit} onChange={e => updateIngredient(ing.id, 'pricePerUnit', parseFloat(e.target.value) || 0)} className="w-full border-slate-200 rounded text-sm py-1 text-slate-900" />
                                    </td>
                                    <td className="px-4 py-2 text-right font-mono text-slate-600">
                                        {formatCurrency(ing.quantity * ing.pricePerUnit)}
                                    </td>
                                    <td className="p-2 text-center">
                                        <button onClick={() => removeIngredient(ing.id)} className="text-red-400 hover:text-red-600">×</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <button onClick={addIngredient} className="w-full py-3 text-slate-500 hover:bg-slate-50 text-sm font-medium border-t border-slate-100 transition-colors">
                        + Agregar Ingrediente
                    </button>
                </div>

                <button
                    onClick={handleSave}
                    className="w-full py-4 bg-green-600 hover:bg-green-700 text-white rounded-xl font-bold text-lg shadow-lg transform transition-all hover:scale-[1.01] flex items-center justify-center gap-3"
                >
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"></path></svg>
                    {recipeId ? 'Guardar Cambios en Ficha' : 'Guardar Receta en Base de Datos'}
                </button>

            </div>

            <div className="xl:col-span-4 space-y-6">

                <div className="bg-indigo-900 text-white rounded-xl shadow-xl overflow-hidden sticky top-24">
                    <div className="p-6 border-b border-indigo-800">
                        <h3 className="text-lg font-bold">Estructura Unitaria</h3>
                        <p className="text-indigo-300 text-sm">Cálculo para {recipeYield} unidad(es)</p>
                    </div>

                    <div className="px-6 py-4 bg-indigo-800/30 border-b border-indigo-800 space-y-3">
                        <div className="flex justify-between items-center">
                            <div className="flex items-center gap-2">
                                <p className="text-xs text-indigo-300 uppercase font-bold">Make Up / Seguridad</p>
                            </div>
                            <div className="flex items-center gap-1">
                                <input
                                    type="number"
                                    className="w-20 h-7 text-right bg-indigo-900 border border-indigo-700 rounded text-white text-xs focus:ring-1 focus:ring-indigo-400"
                                    value={settings.safetyFactor}
                                    onChange={e => setSettings({ ...settings, safetyFactor: parseFloat(e.target.value) || 0 })}
                                />
                                <span className="text-xs text-indigo-400 w-4">%</span>
                            </div>
                        </div>
                        <div className="flex justify-between items-center">
                            <div className="flex items-center gap-2">
                                <p className="text-xs text-indigo-300 uppercase font-bold">Mano de Obra (Lote)</p>
                            </div>
                            <div className="flex items-center gap-1">
                                <span className="text-xs text-indigo-400">$</span>
                                <input
                                    type="number"
                                    className="w-20 h-7 text-right bg-indigo-900 border border-indigo-700 rounded text-white text-xs focus:ring-1 focus:ring-indigo-400"
                                    value={settings.laborCost}
                                    onChange={e => setSettings({ ...settings, laborCost: parseFloat(e.target.value) || 0 })}
                                />
                                <span className="w-4"></span>
                            </div>
                        </div>
                        <div className="flex justify-between items-center">
                            <div className="flex items-center gap-2">
                                <p className="text-xs text-indigo-300 uppercase font-bold">Packaging (Lote)</p>
                            </div>
                            <div className="flex items-center gap-1">
                                <span className="text-xs text-indigo-400">$</span>
                                <input
                                    type="number"
                                    className="w-20 h-7 text-right bg-indigo-900 border border-indigo-700 rounded text-white text-xs focus:ring-1 focus:ring-indigo-400"
                                    value={settings.packagingCost}
                                    onChange={e => setSettings({ ...settings, packagingCost: parseFloat(e.target.value) || 0 })}
                                />
                                <span className="w-4"></span>
                            </div>
                        </div>
                    </div>

                    <div className="p-6 space-y-4">
                        <div className="flex justify-between items-end pb-4 border-b border-indigo-800/50">
                            <div>
                                <p className="text-xs uppercase text-indigo-300 font-bold mb-1">Costo Neto Unitario</p>
                                <p className="text-xs text-indigo-400">(Ingredientes + MO + Pack) / {recipeYield}</p>
                            </div>
                            <span className="text-2xl font-mono font-bold">{formatCurrency(totalUnitCost)}</span>
                        </div>

                        <div className="flex justify-between items-center">
                            <div className="flex items-center gap-2">
                                <p className="text-sm text-indigo-200">Margen Sugerido</p>
                                <input
                                    type="number"
                                    className="w-16 h-8 text-right bg-indigo-800 border-none rounded text-white text-sm focus:ring-1 focus:ring-indigo-400"
                                    value={settings.targetMargin}
                                    onChange={e => setSettings({ ...settings, targetMargin: parseFloat(e.target.value) || 0 })}
                                />
                                <span className="text-xs text-indigo-400">%</span>
                            </div>
                            <span className="font-mono text-indigo-100">+ {formatCurrency(profitAmount)}</span>
                        </div>

                        <div className="flex justify-between items-center">
                            <p className="text-sm text-indigo-200">IVA (19%)</p>
                            <span className="font-mono text-indigo-100">+ {formatCurrency(taxAmount)}</span>
                        </div>

                        <div className="flex justify-between items-center">
                            <div className="flex items-center gap-2">
                                <p className="text-sm text-indigo-200">Comisión (GetNet)</p>
                                <input
                                    type="number"
                                    className="w-16 h-8 text-right bg-indigo-800 border-none rounded text-white text-sm focus:ring-1 focus:ring-indigo-400"
                                    value={settings.bankFee}
                                    onChange={e => setSettings({ ...settings, bankFee: parseFloat(e.target.value) || 0 })}
                                />
                                <span className="text-xs text-indigo-400">%</span>
                            </div>
                            <span className="font-mono text-indigo-100">+ {formatCurrency(bankFeeAmount)}</span>
                        </div>

                        <div className="pt-6 mt-2 border-t border-indigo-700">
                            <p className="text-center text-xs uppercase tracking-widest text-indigo-300 font-bold mb-2">Precio de Venta Sugerido</p>
                            <div className="bg-indigo-500 rounded-lg p-4 text-center shadow-inner">
                                <span className="text-3xl font-extrabold font-mono text-white">{formatCurrency(calculated.finalPrice)}</span>
                            </div>
                        </div>

                        <div className="pt-6 mt-2 border-t border-indigo-700/50">
                            <p className="text-center text-xs uppercase tracking-widest text-green-300 font-bold mb-2">Precio Venta Real (Manual)</p>
                            <div className="bg-green-600 rounded-lg p-1 shadow-md">
                                <input
                                    type="number"
                                    value={realPrice || ''}
                                    onChange={(e) => setRealPrice(parseFloat(e.target.value) || 0)}
                                    placeholder="$ 0"
                                    className="w-full bg-green-700 border-none text-white text-center text-2xl font-bold font-mono placeholder-green-400 focus:ring-0 rounded"
                                />
                            </div>
                            {realPrice > 0 && (
                                <div className="mt-2 text-center">
                                    <p className="text-xs text-indigo-200">
                                        Margen Real: <span className={`font-bold ${realMarginPercent >= settings.targetMargin ? 'text-green-300' : 'text-red-300'}`}>
                                            {realMarginPercent.toFixed(1)}%
                                        </span>
                                    </p>
                                    <p className="text-[10px] text-indigo-400">
                                        (Ingreso Neto: {formatCurrency(realIngresoNeto)})
                                    </p>
                                </div>
                            )}
                        </div>

                    </div>
                </div>
            </div>
        </div>
    );
};

const App = () => {
    const [activeTab, setActiveTab] = useState<'calculator' | 'database' | 'matrix'>('calculator');
    const [recipes, setRecipes] = useState<SavedRecipe[]>([]);
    const [editingRecipe, setEditingRecipe] = useState<SavedRecipe | null>(null);

    useEffect(() => {
        const saved = localStorage.getItem('dolce_recipes');
        if (saved) {
            try {
                setRecipes(JSON.parse(saved));
            } catch (e) {
                console.error("Error loading recipes", e);
            }
        }
    }, []);

    useEffect(() => {
        localStorage.setItem('dolce_recipes', JSON.stringify(recipes));
    }, [recipes]);

    const handleSaveRecipe = (newRecipe: SavedRecipe) => {
        setRecipes(prev => {
            const idx = prev.findIndex(r => r.id === newRecipe.id);
            if (idx >= 0) {
                const copy = [...prev];
                copy[idx] = newRecipe;
                return copy;
            }
            return [...prev, newRecipe];
        });
        setEditingRecipe(null);
        alert('Receta guardada exitosamente.');
    };

    const handleDeleteRecipe = (id: string) => {
        if (confirm('¿Eliminar esta receta permanentemente?')) {
            setRecipes(prev => prev.filter(r => r.id !== id));
        }
    };

    const handleEditRecipe = (recipe: SavedRecipe) => {
        setEditingRecipe(recipe);
        setActiveTab('calculator');
    };

    const handleBatchUpdate = (updatedRecipes: SavedRecipe[]) => {
        setRecipes(updatedRecipes);

        // Si estamos editando una receta y esta fue actualizada en el lote, actualizamos el estado de edición también
        if (editingRecipe) {
            const updatedVersion = updatedRecipes.find(r => r.id === editingRecipe.id);
            if (updatedVersion) {
                setEditingRecipe(updatedVersion);
            }
        }
    };

    const handleImportRecipes = (importedRecipes: SavedRecipe[]) => {
        setRecipes(importedRecipes);
    };

    return (
        <div className="min-h-screen bg-slate-100 font-sans text-slate-800">
            <nav className="bg-indigo-900 text-white shadow-lg sticky top-0 z-50">
                <div className="max-w-7xl mx-auto px-4">
                    <div className="flex items-center justify-between h-16">
                        <div className="flex items-center gap-2 font-bold text-xl">
                            <span>🍬 DolceCostos</span>
                        </div>
                        <div className="flex space-x-2">
                            <button
                                onClick={() => { setActiveTab('calculator'); setEditingRecipe(null); }}
                                className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === 'calculator' ? 'bg-white text-indigo-900' : 'text-indigo-200 hover:bg-indigo-800'}`}
                            >
                                Calculadora
                            </button>
                            <button
                                onClick={() => setActiveTab('database')}
                                className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === 'database' ? 'bg-white text-indigo-900' : 'text-indigo-200 hover:bg-indigo-800'}`}
                            >
                                Base de Datos
                            </button>
                            <button
                                onClick={() => setActiveTab('matrix')}
                                className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === 'matrix' ? 'bg-white text-indigo-900' : 'text-indigo-200 hover:bg-indigo-800'}`}
                            >
                                Insumos
                            </button>
                        </div>
                    </div>
                </div>
            </nav>

            <main className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8">
                {activeTab === 'calculator' && (
                    <CalculatorTab
                        initialRecipe={editingRecipe}
                        onSave={handleSaveRecipe}
                    />
                )}
                {activeTab === 'database' && (
                    <DatabaseTab
                        recipes={recipes}
                        onEdit={handleEditRecipe}
                        onDelete={handleDeleteRecipe}
                        onImport={handleImportRecipes}
                    />
                )}
                {activeTab === 'matrix' && (
                    <PriceMatrixTab
                        recipes={recipes}
                        onBatchUpdate={handleBatchUpdate}
                    />
                )}
            </main>
        </div>
    );
};

const root = createRoot(document.getElementById('app')!);
root.render(<App />);