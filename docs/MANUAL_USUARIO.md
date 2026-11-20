# Manual de usuario de GOMAQ

Este manual explica cómo usar el sistema según el rol de cada persona. Está escrito a partir de lo que hacen las
pantallas hoy; los textos entre comillas son los que se ven en la aplicación.

GOMAQ tiene dos aplicaciones:

- **Panel web**: lo usan el equipo de oficina (administrativo y gerente) y los clientes (portal). Se abre en el navegador.
- **App del mecánico** ("GOMAQ Mecánico"): se instala en el teléfono Android de cada mecánico y sigue funcionando sin señal.

Para instalar, configurar y mantener el sistema, ver [README.md](../README.md), [ARQUITECTURA.md](ARQUITECTURA.md) y
[DESPLIEGUE.md](DESPLIEGUE.md).

## Contenido

1. [Roles y a dónde entra cada uno](#1-roles-y-a-dónde-entra-cada-uno)
2. [Entrar, activar la cuenta y recuperar la clave](#2-entrar-activar-la-cuenta-y-recuperar-la-clave)
3. [Administrativo y gerente: el panel](#3-administrativo-y-gerente-el-panel)
4. [Mecánico: la app del teléfono](#4-mecánico-la-app-del-teléfono)
5. [Cliente: el portal](#5-cliente-el-portal)
6. [Preguntas frecuentes](#6-preguntas-frecuentes)

## 1. Roles y a dónde entra cada uno

| Rol | Dónde trabaja | Qué hace en resumen |
|---|---|---|
| Administrativo | Panel web | Opera todo el día a día: órdenes, asignación de mecánicos, guías, facturas, cobranza, insumos, equipos y clientes. |
| Gerente | Panel web | Ve lo mismo que el administrativo y además aprueba la valorización de las reparaciones, cambia las reglas de cobro y es el único que gestiona cuentas de otros gerentes. |
| Mecánico | App del teléfono | Recibe órdenes, trabaja en terreno, registra repuestos, fotos y tiempos, y cierra la orden. |
| Cliente | Portal web | Ve sus equipos, pide asistencia, sigue la visita del técnico y revisa su historial y sus documentos. |

Al iniciar sesión, cada rol cae en su pantalla: el cliente va al portal, el administrativo y el gerente al panel
(pantalla de inicio) y el mecánico a la app del teléfono. Si un mecánico abre el panel web, ve un aviso que le indica usar la app
"GOMAQ Mecánico".

## 2. Entrar, activar la cuenta y recuperar la clave

### Iniciar sesión

En el panel web: escribe tu **Correo** y tu **Contraseña** y toca **Ingresar**. En la app del mecánico es igual
(requiere conexión a internet solo para entrar; después trabaja sin señal).

Mensajes que puedes ver:

- "Correo o contraseña incorrectos".
- "Tu cuenta está en revisión...": tu solicitud de cuenta todavía no la aprueba GOMAQ (solo clientes). Podrás entrar con
  ese mismo correo apenas quede lista.
- "Tu cuenta está desactivada. Contacta a GOMAQ".
- "Tu sesión expiró, vuelve a iniciar sesión".

### Activar una cuenta invitada (personal de GOMAQ)

Cuando un administrador te invita, recibes un código de 6 dígitos (vale 72 horas).

1. En la pantalla de ingreso toca **Tengo un código de invitación**.
2. Escribe el **Correo de acceso**, el **Código de 6 dígitos** y elige tu contraseña (mínimo 8 caracteres) dos veces.
3. Toca **Activar mi cuenta**. Quedas con la sesión iniciada.

### Recuperar la contraseña

1. En la pantalla de ingreso toca **¿Olvidaste tu contraseña?**, escribe tu correo y toca **Enviar código**.
2. Te llega un código por correo (vale 15 minutos; se puede pedir uno por minuto y hasta cinco por hora). Revisa también el spam.
3. Toca **Ya tengo un código**, escribe el correo, el código y la contraseña nueva, y toca **Cambiar contraseña**.

Si tu cuenta no tiene un correo real, pide el código a GOMAQ: un administrador puede generártelo (vale 24 horas).
Tras cambiar la contraseña se cierran las demás sesiones abiertas. El código se bloquea tras 5 intentos fallidos.

### Cambiar tu contraseña estando dentro

En el panel y en el portal, el icono **Cambiar mi contraseña** (abajo en el menú o arriba a la derecha) la actualiza y
muestra "Contraseña cambiada".

### Cerrar sesión

El botón **Cerrar sesión** pide confirmación. En el portal ofrece además **Cerrar sesión en todos los dispositivos**.

## 3. Administrativo y gerente: el panel

### El menú

Los dos roles ven los mismos ítems; lo que cambia es qué botones aparecen dentro de cada pantalla (ver la
tabla de la sección 3.10).

| Grupo | Ítems |
|---|---|
| Operación | Inicio, Flota, Mapa, Órdenes de Trabajo, Asistencias, Mantención |
| Inventario | Insumos, Vehículos |
| Comercial | Guías, Facturar, Facturas emitidas, Costo por equipo, Clientes, Cuentas por aprobar |
| Administración | Notificaciones |

Junto a varios ítems aparece un contador naranja con lo que está pendiente (mantenciones vencidas, órdenes sin asignar,
asistencias por atender, avisos con problemas, facturas por emitir, guías sin documento, descuadres de inventario,
cuentas por aprobar). Al tocar un ítem con contador, se abre la lista ya filtrada.

Abajo en la barra están tu nombre y rol (abre **Mi perfil y mis avisos**), la campana de avisos, **Cambiar mi
contraseña** y **Cerrar sesión**. En pantallas angostas el menú se abre con **Abrir menú**.

### 3.1 Inicio

Muestra los pendientes ordenados por urgencia: mantenciones vencidas, órdenes sin asignar, asistencias por atender,
avisos con problemas, por facturar, arriendos con períodos sin facturar, reparaciones por valorizar, guías sin
documento, descuadres de inventario, cuentas por aprobar y mantenciones próximas. Lo que le corresponde al otro rol sale
al final, marcado "(lo hace Administrativo)" o "(lo hace Gerente)". Sin pendientes dice "Todo al día".

Además hay tarjetas de disponibilidad comercial (equipos arrendados y disponibles), cobranza (facturas vencidas y por
vencer en 7 días), gráficos de estado operativo y de órdenes por mes, y las ventas por ejecutivo. El botón
**Nueva orden de trabajo** crea una orden desde aquí.

### 3.2 Flota y perfil de equipo

**Flota** lista los equipos con Código, Equipo, Combustible, Estado y Cliente. Se busca por código, marca o modelo y se
filtra por estado (Operativa, Parcialmente operativa, En mantención, Fuera de servicio) y por cliente. Tocar un equipo abre
su perfil, con las pestañas **Resumen**, **Ficha técnica**, **Línea de tiempo**, **Documentos** y, cuando hay datos,
**Costos**.

Solo el administrativo puede agregar equipos (**Nueva maquinaria**: Código, Categoría y Tipo son obligatorios) y
modificar un equipo: cambiar estado, crear una orden de trabajo, asignarlo a un cliente o retirarlo, editar la ficha
técnica y subir la foto. El gerente consulta.

### 3.3 Mapa

El **Mapa operativo** muestra equipos, la bodega y los furgones que van en camino, con su destino y hora estimada de
llegada (la distancia que se ve es en línea recta, no por ruta). Se busca por equipo, cliente o técnico y se refresca
solo. Si la bodega no tiene ubicación, **Cargar ubicación** la guarda.

### 3.4 Órdenes de trabajo

Pestañas: **Sin asignar**, **En curso**, **Finalizadas** y **Todas**, más un filtro por estado.

- **Nueva OT**: elige el **Equipo** y escribe el **Motivo** (qué falla o qué trabajo se pide). Ambos roles pueden crearla.
- **Asignar** (solo administrativo, en la pestaña Sin asignar): elige un mecánico de la lista de disponibles y toca
  **Asignar y Notificar**. El mecánico recibe el aviso.
- El **detalle de la orden** muestra los datos, el mapa, los repuestos usados y el historial de cambios.
  - El administrativo puede **Asignar mecánico** o **Reasignar**. Si el mecánico anterior ya estaba en camino o en terreno,
    el sistema pide confirmar y avisa que lo que el mecánico anterior no alcanzó a enviar queda rechazado.
  - Cada repuesto se marca **Se cobra**, **No se cobra** o **Por decidir**, y se puede **Anular línea**. Si la orden ya
    está cerrada, el cambio exige escribir un motivo; si ya tiene factura, no se toca.
  - **Aprobar valorización** (solo gerente): se escribe el **Monto** y se toca **Aprobar**. Solo se puede cuando la orden
    está finalizada y es facturable. No deja aprobar si hay repuestos "Por decidir": hay que decidir cada uno antes.
  - **Subir PDF de factura** con su **Folio SII** (solo administrativo, orden facturable y finalizada). Una vez cargada,
    cualquiera de los dos roles puede **Anular factura** con un motivo; eso solo corrige el registro en GOMAQ y hay que
    emitir la nota de crédito en el SII.

### 3.5 Asistencias

Son las solicitudes que hacen los clientes desde su portal, con la foto si la adjuntaron. **Convertir en OT** crea la orden de
trabajo ("Asistencia convertida en orden de trabajo"). Ojo: cuando un cliente pide asistencia, el sistema ya crea la
orden por su cuenta (queda pendiente y sin técnico) y avisa a los mecánicos libres y a la oficina; esta pantalla recoge
los casos que quedaron pendientes.

### 3.6 Mantención y horómetro

Dos pestañas: **Por medir este mes** y **Mantención**. La preventiva toca cada 350 horas de uso (configurable por equipo) y
el sistema avisa cuando faltan 50 horas o menos.

- **Registrar**: ingresa las **Horas del horómetro** (y una observación). Si la lectura es menor que la anterior, pregunta
  "La lectura es menor" y permite **Revisar** o **Guardar igual**. La casilla "Se hizo la mantención preventiva"
  reinicia el contador.
- **Mantención hecha**: confirma la mantención de un equipo en alerta con el **Horómetro de la mantención**.
- **Historial**: las lecturas anteriores del equipo.

### 3.7 Insumos y vehículos

**Insumos** tiene tres pestañas: **Catálogo**, **Consumos recientes** y **Descuadres**.

- Solo el administrativo crea insumos (**Nuevo insumo**: nombre y unidad de medida) y registra **Ingreso** de stock.
- Un descuadre es una ubicación con un repuesto en negativo (por ejemplo, el mecánico instaló una pieza que el sistema no
  tenía en su furgón). Ambos roles pueden **Ver movimientos**; solo el administrativo puede **Traspasar** desde bodega al
  furgón o **Registrar conteo** (cantidad, motivo obligatorio y nota). Antes de contar un furgón conviene que el mecánico
  haya sincronizado todo su trabajo.

**Vehículos** administra los furgones: patente (obligatoria), tipo, marca, modelo, año, kilometraje y el mecánico
asignado. Un vehículo "Sin asignar" no lleva stock. Ambos roles pueden crear y editar.

### 3.8 Facturación y cobranza

**Guías** (solo el administrativo las registra; el gerente ve la lista de las que faltan documento):

1. Elige el tipo: **Guía de Despacho** o **Guía de Recepción**.
2. Elige el equipo (en despacho, los disponibles; en recepción, los que están con un cliente) y, para un despacho, el cliente.
3. Sube el **PDF** (arrastrándolo o con un clic; solo PDF, hasta 10 MB). El sistema lee fecha, hora y tipo y pide revisarlos.
   Si todavía no tienes el PDF, marca "Todavía no tengo el PDF: registrar sin documento" y adjúntalo después desde la lista "Falta el documento".
4. Revisa fecha y hora (no pueden ser futuras; la hora define si se cobra ese día), el horómetro (opcional) y toca **Guardar guía**.

Un despacho o retiro fallido se marca aparte y no se factura ni cuenta como día de arriendo.

**Facturar** tiene tres pestañas: **Por facturar**, **Pendiente de valorizar** y **Arriendos en curso**.

- *Por facturar*: el administrativo abre cada elemento, sube el PDF de la factura del SII con su **Folio SII**, el monto, las
  fechas de emisión y vencimiento y, en arriendos, el período facturado. Luego revisa los datos y toca **Enviar factura
  por correo** (el asunto y el mensaje se pueden editar y restaurar). Si cierras sin enviar, el sistema avisa.
- *Pendiente de valorizar*: reparaciones esperando monto. El gerente lo pone; el administrativo ve que falta ese paso.
- *Arriendos en curso*: muestra las **Reglas de cobro** (día de facturación del 1 al 28 y hora de corte). Solo el gerente
  las edita. Por arriendo, el administrativo usa **Facturar período**.

**Facturas emitidas** muestra todas las facturas con filtros (Todas, Por cobrar, Vencidas, Próximas a vencer, Pagadas,
Anuladas), búsqueda por folio o cliente y **Exportar a Excel** por rango de fechas. Ambos roles ven y exportan; solo el
administrativo registra:

- **Marcar pagada**: pide la **Fecha de pago** y el comprobante (foto JPG, PNG o PDF de hasta 10 MB). El comprobante es
  obligatorio: sin él no se puede guardar.
- **Adjuntar comprobante** a una factura pagada antes de existir esa regla; **Deshacer pago**.
- **Anulada con nota de crédito**: exige el folio de la nota; la factura sale de la cobranza. **Deshacer anulación**.
- **Corregir**: monto neto y fecha de vencimiento.

**Costo por equipo** compara el gasto en repuestos con lo facturado (rango de 3, 6, 12 o 24 meses) y marca los equipos a
pérdida. Es solo lectura para ambos.

### 3.9 Clientes, cuentas y notificaciones

**Clientes** tiene las pestañas **Clientes** y **Cuentas por aprobar**. Ambos roles crean clientes (**Nuevo cliente**:
razón social, RUT, teléfono, correo de avisos y facturas, giro, ejecutivo) y editan sus datos y ubicación. Al tocar un
cliente se ve su historial.

**Cuentas por aprobar**:

- *Solicitudes de clientes*: cada una trae contacto, correo (confirmado o no), RUT, teléfono y dirección. Elige **Crear cliente nuevo**,
  **Vincular a cliente existente** (**Vincular y activar**) o **Rechazar** (la persona puede volver a postular con el mismo
  correo). Si el cliente no confirmó su correo, el sistema pide confirmar que se aprueba igual.
- *Cuentas del equipo*: **Invitar cuenta** (nombre, correo, rol y cómo se entrega el código). Por cada cuenta: **Nuevo código**,
  **Revocar** (borra una cuenta pendiente), **Contraseña** (restablecer) y **Desactivar** o **Reactivar**. Solo un gerente
  puede crear o gestionar cuentas de rol gerente; si un administrativo lo intenta, el sistema lo rechaza.
  El código se entrega copiando el mensaje o enviándolo por correo.

**Notificaciones** muestra los últimos avisos enviados, con filtro por canal y el atajo "Avisos con problemas". El
administrativo puede **Reintentar** un aviso o **Reenviar correo** de una factura; no se reenvía lo que está esperando
salir ni las facturas anuladas.

**Mi perfil y mis avisos**: nombre, teléfono y qué tipos de aviso quieres recibir.

### 3.10 Qué puede cada rol

| Acción | Administrativo | Gerente |
|---|---|---|
| Ver flota, mapa, órdenes, mantención, costos, facturas emitidas | Sí | Sí |
| Crear órdenes, convertir asistencias, crear clientes y vehículos | Sí | Sí |
| Asignar o reasignar mecánico | Sí | No |
| Crear o modificar equipos | Sí | No (consulta) |
| Registrar guías | Sí | No (ve las pendientes) |
| Subir, enviar y corregir facturas; marcar pagada; notas de crédito | Sí | No (solo lectura) |
| Crear insumos, ingresos, traspasos y conteos | Sí | No (consulta) |
| Decidir "Se cobra" o "No se cobra" de un repuesto | Sí | Sí |
| Aprobar la valorización de una reparación | No | Sí |
| Editar las reglas de cobro | No | Sí |
| Crear y desactivar cuentas del equipo | Sí (no de gerentes) | Sí |

## 4. Mecánico: la app del teléfono

### 4.1 Antes de empezar

- Entrar requiere señal una vez. Después la app sigue funcionando sin conexión: todo lo que registras se guarda primero en el teléfono y
  se envía solo cuando vuelve la señal. Cada tarea lleva una marca que evita que un reintento duplique datos.
- La app pide permisos del teléfono: **ubicación** (la primera vez que sales hacia el destino), **cámara** (para las
  fotos) y **notificaciones** (para avisarte de órdenes nuevas; es opcional: el cuadro "¿Activar avisos de órdenes?"
  aparece una vez y puedes elegir **Ahora no**).
- Antes de actualizar la app en el teléfono, espera a ver **Todo enviado**. Desinstalarla borra lo que no se ha enviado.

### 4.2 Menú y pantalla principal

El menú lateral tiene: **Mis órdenes**, **Órdenes disponibles**, **Flota**, **Mi cuenta**, **Mi furgón** y **Cerrar sesión**.

**Mis órdenes de trabajo** lista tus órdenes, primero las que están en terreno o en reparación, luego en camino, aceptadas y
el resto. Las finalizadas quedan plegadas en "Finalizadas (N)". Una orden que cerraste en el teléfono y todavía no llegó a
la oficina se ve con la etiqueta "CIERRE SIN ENVIAR". La lista se actualiza sola al volver a la app, cada 3 minutos, al
recuperar la señal y al deslizar hacia abajo.

**Nueva OT** (botón flotante) crea una orden desde el teléfono: elige el equipo de la flota, escribe el motivo y toca
**Crear orden**. Se crea en el servidor apenas haya señal.

La franja de sincronización de arriba dice en qué está tu trabajo:

| Texto | Qué significa |
|---|---|
| "Todo enviado" | No queda nada pendiente. |
| "N cambios por enviar" / "Sin conexión. N cambios guardados en el teléfono" | Todo está guardado y saldrá con la señal. |
| "Enviando cambios…" | Está sincronizando. |
| "N cambios no se pudieron enviar... Toca para ver cuál y reintentar." (rojo) | Un cambio fue rechazado. Tócalo para verlo. |
| "Tu sesión expiró..." | Vuelve a iniciar sesión; tus cambios siguen guardados en el teléfono. |

En "Cambios que no se han enviado" puedes **Reintentar todo** o **Descartar** cada cambio (no se puede deshacer).

### 4.3 Tomar una orden disponible

**Órdenes disponibles** muestra las órdenes sin mecánico (creadas por la oficina o por clientes). Requiere señal a
propósito, para que dos mecánicos no tomen la misma. Toca **Tomar esta orden**, confirma "¿Tomar la OT-N?" y la orden
queda tuya ("OT-N es tuya. Ya aparece en Mis órdenes."). Si otro mecánico la tomó antes, la app lo informa.

### 4.4 Una visita, paso a paso

El botón de abajo cambia según el estado de la orden:

| Estado | Botón de abajo |
|---|---|
| Asignada o pendiente | **ACEPTAR TRABAJO** |
| Aceptada | **SALIR HACIA EL DESTINO** |
| En camino | **LLEGUÉ AL LUGAR** |
| En terreno o en reparación | **FINALIZAR TRABAJO** |
| Finalizada | (solo lectura) |

1. **Aceptar.** No necesita señal; la oficina ve que la recibiste. Si ya estás en el lugar, el atajo "Ya estoy en el lugar:
   iniciar trabajo" salta los pasos intermedios.
2. **Salir hacia el destino.** Aquí Android pide el permiso de ubicación. Aparece la tarjeta **Cómo llegar** con **Google
   Maps** y **Waze**. Mientras vas en camino, la app comparte tu ubicación con la oficina (con una notificación fija "GOMAQ:
   en camino") y se apaga sola al llegar. El cliente ve solo la hora estimada de llegada, no tu posición.
3. **Llegar.** Cuando el teléfono detecta que estás cerca, aparece "Parece que llegaste": confirma con **Llegué al lugar**. El estado
   no cambia solo, hay que confirmar. Al confirmar, la orden pasa a "En terreno" y empieza a correr el tiempo de trabajo.
4. **Pasar a reparación.** Cuando empieces a reparar, toca **Pasar a reparación** para que el cliente lo vea.

Antes de iniciar el trabajo solo se pueden tomar las **Fotos ANTES**. Las demás secciones aparecen bloqueadas con "Se
desbloquea al iniciar el trabajo". Una vez en terreno se habilitan:

- **Observaciones iniciales**: qué se encontró al llegar.
- **Tipo de servicio**: Preventivo, Reparación, Garantía / Full Mantención, Correctivo, Batería / Cargador o Administrativo.
- **Sistemas intervenidos**: marcas dónde trabajaste (mecánicos, electrónicos, hidráulicos y otros).
- **Repuestos utilizados**: elige del catálogo o escribe a mano, indica la cantidad y el precio, y si se le cobra al cliente
  (**Sí**, **No** o **Por decidir**). Toca **Agregar repuesto**. Cada línea muestra si está pendiente de envío o enviada, y
  se puede **Anular línea** (queda tachada y el repuesto vuelve al furgón). Si el repuesto lo usaste en otro equipo, usa **El repuesto va
  a otro equipo**: se abre una orden aparte para ese equipo.
- **Observaciones finales**: qué se hizo y el número de OT en papel (opcional). Se guardan solas al salir.
- **Fotos DESPUÉS**: hace falta al menos una para poder cerrar.
- **Tiempos de trabajo**: **INICIAR TIEMPO DE TRABAJO** y **DETENER TIEMPO DE TRABAJO**. Puede haber varios tramos.
- **Horómetro**: **Agregar lectura de horómetro** guarda la lectura actual del equipo. Si es menor que la última registrada,
  pregunta "La lectura es menor" para que la revises.

### 4.5 Cerrar la orden

**FINALIZAR TRABAJO** está deshabilitado hasta que haya al menos una foto DESPUÉS ("Falta 1 foto del trabajo terminado
(DESPUÉS) para poder cerrar"). Abre la pantalla **Cerrar orden**:

1. Revisa el **Resumen del trabajo** (fotos antes, fotos después y repuestos).
2. Elige **¿Cómo queda el equipo?**: "Queda operativo" o "Queda fuera de servicio". Es obligatorio.
3. Opcionalmente anota el **Horómetro del equipo** y marca "Se hizo la mantención preventiva" si corresponde.
4. Escribe el nombre de **quien recibe el equipo** o marca "No hay persona disponible para recibir". La firma con el dedo es
   opcional, pero respalda la entrega.
5. Toca **CERRAR ORDEN DE TRABAJO** y confirma. Después no puedes cambiar fotos ni repuestos; si te equivocas, avisa al
   administrativo para corregirlo en el panel.

Si no hay señal, la orden se cierra en el teléfono y el cierre se envía cuando vuelva ("OT-N cerrada. Si no hay señal, se
enviará cuando vuelva").

### 4.6 Mi furgón, flota y mi cuenta

- **Mi furgón**: el stock de repuestos de tu vehículo (se ve sin señal). Una cantidad negativa aparece como "Descuadre: bodega
  tiene que revisarlo". **CARGAR DESDE BODEGA** pasa repuestos de bodega a tu furgón y requiere señal, porque se descuentan de bodega en ese
  momento. Si el servidor no responde, reintentar es seguro: no se carga dos veces.
- **Flota**: todos los equipos descargados, con buscador. Al tocar uno ves su ficha técnica, sus lecturas de horómetro y sus
  órdenes anteriores. Desde ahí también puedes registrar el horómetro sin una orden.
- **Mi cuenta**: tus datos (RUT y teléfono; el cliente ve tu nombre, tu RUT y la marca, modelo y patente de tu furgón, pero
  no tu teléfono ni tu correo), el kilometraje de tu vehículo y los documentos del vehículo (permiso de circulación, revisión técnica, seguro y
  otros, con foto o desde la galería). Todo lo de Mi cuenta requiere señal.

### 4.7 Qué se puede hacer sin señal

| Sin señal sí | Con señal |
|---|---|
| Aceptar, salir y llegar a una orden; iniciar trabajo y pasar a reparación | Entrar a la app (login) |
| Observaciones, tipo de servicio, sistemas intervenidos | Órdenes disponibles y **Tomar** |
| Agregar y anular repuestos; tomar fotos; tramos de tiempo | Cargar repuestos desde bodega |
| Registrar el horómetro; cerrar la orden; crear una OT nueva | Todo lo de Mi cuenta |
| Ver flota, historial y furgón ya descargados | Descargar la ficha de un equipo nuevo |

La cola se envía en orden. Un error de red no gasta reintentos; un rechazo real del servidor sí, y tras 5 intentos queda
en "Cambios que no se han enviado" para que lo descartes o lo reintentes.

## 5. Cliente: el portal

### 5.1 Crear la cuenta

1. En la pantalla de ingreso toca **¿Eres cliente? Crea tu cuenta**.
2. Completa los campos con asterisco: **Nombre de contacto**, **Correo electrónico**, **Contraseña** (mínimo 8 caracteres), **Repetir
   contraseña** y **Nombre de la empresa**. Son opcionales el RUT, el teléfono, los horarios de trabajo y colación, la dirección y la ubicación.
3. Toca **Solicitar cuenta**. Si te llega un código de 6 dígitos al correo, escríbelo en "Confirma tu correo" (vale 30 minutos;
   puedes pedir uno nuevo o **Confirmarlo después**).
4. Un administrador de GOMAQ revisa tu solicitud en horario hábil. Mientras tanto, al intentar entrar verás que tu cuenta
   está en revisión. Cuando la aprueban, entras con el mismo correo y contraseña.

### 5.2 Las cuatro pestañas

El portal tiene una barra inferior con **Mis equipos**, **Seguimiento**, **Historial** y **Mi empresa**. Arriba están
**Refrescar**, la campana de avisos, **Cambiar mi contraseña** y **Cerrar sesión**.

**Mis equipos** lista los equipos que tienes en arriendo, con su ubicación y estado. Cada equipo tiene tres botones:

- **Solicitar asistencia**: abre el pedido (ver abajo).
- **Documentos**: guías, órdenes y facturas del equipo. Solo salen los documentos de los períodos en que el equipo fue tuyo.
- **Agregar detalle** (si ya tienes una asistencia abierta en ese equipo) o "Asistencia en curso" (cuando el técnico ya aceptó
  y no se puede agregar más).

Más abajo, **Equipos anteriores** muestra los que tuviste antes y sus documentos.

**Seguimiento** muestra tus asistencias abiertas. Cada tarjeta tiene una barra de 6 pasos: Solicitud recibida, Técnico
asignado, Técnico aceptó, Técnico en camino, Trabajando en tu equipo y Finalizada, con la hora de cada paso. Cuando el técnico va en camino ves
"Llega en ~N min (hora estimada ...)". Si la hora ya pasó dice "Debería llegar en cualquier momento". Tocar una tarjeta
abre el detalle con el técnico y su vehículo.

**Historial** lista los trabajos terminados, con su factura y el comprobante de pago cuando existen. El detalle muestra el
motivo, el diagnóstico, la observación final, la línea de tiempo y las fotos de antes y después. No muestra montos
internos.

**Mi empresa** muestra los datos de la empresa (solo lectura; para cambiarlos hay que contactar a GOMAQ) y permite editar los
datos de contacto: correo de la empresa (donde llegan los avisos y las facturas; no es el correo con que inicias sesión),
teléfono, horarios, dirección y ubicación. Toca **Guardar**.

### 5.3 Pedir asistencia

1. En **Mis equipos**, toca **Solicitar asistencia** en el equipo.
2. Elige qué necesitas: **Reportar una falla** o **Mantención preventiva**.
3. Si es una falla, indica cómo está el equipo: "Sigue operando", "Opera parcialmente" o "No funciona (fuera de servicio)".
4. Describe el problema (obligatorio) y, si quieres, **Adjuntar una foto**.
5. Toca **Solicitar asistencia**. Verás "Asistencia solicitada. Te contactaremos pronto." y el portal pasa a Seguimiento.

El sistema crea de inmediato una orden de trabajo y avisa a los mecánicos libres y a la oficina. Según la gravedad que indiques, el estado del equipo puede
cambiar solo. Solo puede haber una asistencia abierta por equipo: si ya hay una, el botón pasa a **Agregar detalle** para
sumar información en vez de pedir otra. Si tu cuenta no está vinculada a una empresa, pide a GOMAQ que la vincule.

### 5.4 Avisos

La campana permite activar avisos de tu asistencia (con el navegador abierto o también cerrado, según lo que permita tu
dispositivo). Se avisa cuando se asigna un técnico, cuando acepta la orden, cuando va en camino, cuando está trabajando
en tu equipo y cuando la orden se finaliza. Nunca se piden permisos sin que los actives tú.

## 6. Preguntas frecuentes

**No me llega el código por correo.** Revisa el spam. Si tu cuenta no tiene un correo real, pide a GOMAQ que genere el
código (vale 24 horas).

**El código dice que no es válido.** Puede haber vencido o haberse agotado tras 5 intentos. Pide uno nuevo.

**Un cambio quedó en rojo en la app del mecánico.** Toca la franja roja, revisa cuál es y usa **Reintentar todo**. Si el
servidor lo rechaza (por ejemplo, la orden se reasignó a otro técnico), descártalo y avisa a la oficina.

**No puedo cerrar la orden.** Falta al menos una foto DESPUÉS, indicar cómo queda el equipo o quién recibe el trabajo.

**No puedo aprobar una valorización.** La orden debe estar finalizada y no puede tener repuestos "Por decidir": decide
cada uno primero. Solo el gerente aprueba.

**No puedo marcar una factura como pagada.** El comprobante de pago es obligatorio (foto JPG, PNG o PDF de hasta 10 MB).

**Un equipo no aparece al registrar una guía.** En un despacho solo salen los equipos disponibles; en una recepción, los que están con un
cliente. Activa **Ver todos los equipos** para ver el resto.

**Mi cuenta está desactivada.** La desactiva un administrativo o gerente. Contacta a GOMAQ.
