const express = require('express');
const { verifyToken, requireRole } = require('../middleware/auth');
const { ErrorLimite, crearLimitador, normalizarTexto, buscarDirecciones, hayLlave, MIN_LETRAS } = require('../services/geocodificar');

const router = express.Router();
const limitador = crearLimitador();

// sugerencias de direcciones para ubicar un cliente o la bodega.
// Solo la oficina. Devuelve [{ etiqueta, latitud, longitud }], hasta 6, solo de Chile.
router.get('/', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const texto = normalizarTexto(req.query.texto);
    if (!texto) {
        return res.status(400).json({ error: `Escribe al menos ${MIN_LETRAS} letras de la dirección` });
    }
    if (!hayLlave()) {
        return res.status(503).json({ error: 'El buscador de direcciones no está configurado' });
    }
    try {
        // el limitador cuenta cada consulta real al proveedor (una busqueda puede hacer hasta tres)
        const antesDeConsultar = () => {
            const permiso = limitador.intentar(req.user.id);
            if (!permiso.ok) throw new ErrorLimite(permiso.motivo);
        };
        res.json(await buscarDirecciones(texto, { antesDeConsultar }));
    } catch (err) {
        if (err instanceof ErrorLimite) {
            return res.status(429).json({
                error: err.motivo === 'diario'
                    ? 'Se alcanzó el límite diario del buscador de direcciones. Marca el punto de otra forma o vuelve mañana.'
                    : 'Estás buscando muy seguido. Espera unos segundos.',
            });
        }
        // no se devuelve el detalle del proveedor, solo si vale la pena reintentar
        const reintentable = err && ['timeout', 'red', 'servidor', 'limite_minuto'].includes(err.tipo);
        if (!(err && err.name === 'ErrorOrs')) console.error(err);
        res.status(502).json({
            error: reintentable
                ? 'El buscador de direcciones no responde ahora. Intenta de nuevo en un momento.'
                : 'El buscador de direcciones no está disponible.',
        });
    }
});

module.exports = router;
