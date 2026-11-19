// Ordenes de trabajo. Un router por tema, en el orden en que se registraban (las rutas con parametros dependen de ese orden).
const express = require('express');

const router = express.Router();

router.use(require('./consulta'));
router.use(require('./asignacion'));
router.use(require('./trabajo'));
router.use(require('./cierre'));

module.exports = router;
