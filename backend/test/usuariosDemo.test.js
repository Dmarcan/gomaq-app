const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Las credenciales de prueba viven en dos lugares (el script que crea los usuarios y las apps
// Flutter que las usan en el inicio rapido). Si se desincronizan, el boton falla con "credenciales
// incorrectas" y cuesta entender por que.
test('las credenciales demo del script coinciden con las de comun/lib/usuarios_demo.dart', () => {
    const dart = fs.readFileSync(path.join(__dirname, '../../comun/lib/usuarios_demo.dart'), 'utf8');
    const { USUARIOS } = require('../scripts/usuarios-demo');
    const enDart = [...dart.matchAll(/UsuarioDemo\('[^']*', '([^']+)', '([^']+)'\)/g)]
        .map(([, email, clave]) => ({ email, clave }));
    assert.equal(enDart.length, USUARIOS.length);
    for (const u of USUARIOS) {
        assert.ok(
            enDart.some((d) => d.email === u.email && d.clave === u.clave),
            `${u.email} no coincide con comun/lib/usuarios_demo.dart`
        );
        assert.ok(u.clave.length >= 8, 'la contrasena debe cumplir el minimo del sistema');
    }
});
