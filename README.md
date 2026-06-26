# DolceCostos

Herramienta web para calcular costos de recetas y gestionar ingredientes, pensada para emprendedores gastronómicos.

## Stack

- React + TypeScript + Vite
- Tailwind CSS
- Supabase (auth + base de datos)

## Correr localmente

**Requisitos:** Node.js

1. Instalar dependencias:
   ```bash
   npm install
   ```

2. Crear el archivo `.env.local` en la raíz del proyecto con las siguientes variables:
   ```
   SUPABASE_URL=tu_supabase_url
   SUPABASE_ANON_KEY=tu_supabase_anon_key
   ```

3. Correr la app:
   ```bash
   npm run dev
   ```
