// Usuarios y cuentas. Un router por tema, en el orden en que se registraban.
const express = require('express');

const router = express.Router();

router.use(require('./cuentas'));
router.use(require('./solicitudesCliente'));
router.use(require('./perfil'));

module.exports = router;
