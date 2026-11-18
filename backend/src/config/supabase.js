const { createClient } = require('@supabase/supabase-js');

// Cada llamada a Supabase tiene un plazo: sin el, un Storage lento deja la peticion colgada.
// 30 s cubre una subida de 10 MB con mala conexion; si la llamada ya trae su propia senal, se respeta.
const PLAZO_SUPABASE_MS = Number(process.env.SUPABASE_TIMEOUT_MS) > 0 ? Number(process.env.SUPABASE_TIMEOUT_MS) : 30000;
const fetchConPlazo = (url, opciones = {}) => fetch(url, {
    ...opciones,
    signal: opciones.signal || AbortSignal.timeout(PLAZO_SUPABASE_MS),
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    global: { fetch: fetchConPlazo },
});

// bucket para fotos de evidencia subidas por el mecanico desde terreno (offline-first)
const BUCKET = process.env.SUPABASE_BUCKET || 'evidencias-ot';

// bucket para documentos administrativos: guias y facturas, subidos desde el panel web
const BUCKET_DOCUMENTOS = process.env.SUPABASE_BUCKET_DOCUMENTOS || 'documentos-gomaq';

// bucket para fotos de fichas tecnicas de maquinarias, subidas desde el panel web
const BUCKET_EQUIPOS = process.env.SUPABASE_BUCKET_EQUIPOS || 'equipos-gomaq';

module.exports = { supabase, BUCKET, BUCKET_DOCUMENTOS, BUCKET_EQUIPOS };
