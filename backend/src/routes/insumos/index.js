// Insumos: catalogo, stock entre ubicaciones y lineas de repuesto de las OT. Un router por tema, en el orden en que se registraban.
const express = require('express');

const router = express.Router();

router.use(require('./catalogo'));
router.use(require('./stock'));
router.use(require('./lineasOrden'));

module.exports = router;
