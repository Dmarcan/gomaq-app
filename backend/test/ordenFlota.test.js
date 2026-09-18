const { test, describe } = require('node:test');
const assert = require('node:assert');

const { ordenSql, COLUMNAS } = require('../src/utils/ordenFlota');

const sinEspacios = (s) => s.replace(/\s+/g, ' ');

describe('ordenSql', () => {
    test('por defecto ordena por codigo natural: PL-602 antes que PL-1101', () => {
        const sql = sinEspacios(ordenSql(undefined, undefined));
        // el N. interno se compara como numero; como texto "1101" quedaria antes que "602"
        assert.match(sql, /::int ASC/);
        assert.match(sql, /^split_part\(m\.codigo, '-', 1\) ASC/);
    });

    test('ordenar por una columna deja el codigo natural como desempate', () => {
        const sql = sinEspacios(ordenSql('altura', 'desc'));
        assert.ok(sql.startsWith('m.altura_trabajo DESC NULLS LAST, split_part'), sql);
        // el desempate siempre asciende: el orden de las paginas no depende del sentido pedido
        assert.match(sql, /m\.codigo ASC$/);
    });

    test('los vacios van al final aunque se ordene de mayor a menor', () => {
        for (const columna of ['altura', 'capacidad', 'marca', 'cliente']) {
            assert.match(ordenSql(columna, 'desc'), /DESC NULLS LAST/, columna);
            assert.match(ordenSql(columna, 'asc'), /ASC NULLS LAST/, columna);
        }
    });

    test('el sentido solo puede ser asc o desc', () => {
        assert.match(ordenSql('estado', 'DESC'), /^m\.estado DESC/);
        assert.match(ordenSql('estado', 'cualquier cosa'), /^m\.estado ASC/);
        assert.match(ordenSql('estado', undefined), /^m\.estado ASC/);
    });

    test('un orden inventado no entra a la consulta', () => {
        const ataques = ["x'; DROP TABLE maquinarias; --", 'm.codigo; SELECT 1', '__proto__', 'constructor', 'toString', ''];
        for (const ataque of ataques) {
            const sql = ordenSql(ataque, 'asc');
            assert.strictEqual(sql, ordenSql('codigo', 'asc'), `"${ataque}" debio caer en el orden por defecto`);
            assert.ok(!sql.includes('DROP') && !sql.includes('SELECT'), sql);
        }
    });

    test('el sentido tampoco es una via de inyeccion', () => {
        const sql = ordenSql('estado', 'DESC; DROP TABLE maquinarias');
        assert.ok(!sql.includes('DROP'), sql);
    });

    test('toda columna ordenable es una expresion fija del listado', () => {
        for (const [nombre, expresion] of Object.entries(COLUMNAS)) {
            if (expresion === null) continue;
            assert.match(expresion, /^[mc]\.[a-z_]+$/, `${nombre}: ${expresion}`);
        }
    });
});
