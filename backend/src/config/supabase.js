const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// bucket para fotos de evidencia subidas por el mecanico desde terreno (offline-first)
const BUCKET = process.env.SUPABASE_BUCKET || 'evidencias-ot';

// bucket para documentos administrativos: guias y facturas, subidos desde el panel web
const BUCKET_DOCUMENTOS = process.env.SUPABASE_BUCKET_DOCUMENTOS || 'documentos-gomaq';

// bucket para fotos de fichas tecnicas de maquinarias, subidas desde el panel web
const BUCKET_EQUIPOS = process.env.SUPABASE_BUCKET_EQUIPOS || 'equipos-gomaq';

module.exports = { supabase, BUCKET, BUCKET_DOCUMENTOS, BUCKET_EQUIPOS };
