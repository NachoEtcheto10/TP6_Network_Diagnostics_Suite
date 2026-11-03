# Network Diagnostics Suite: documento técnico

Desarrollo de Aplicaciones Móviles 2026, TP6.

Este documento describe tres aspectos que pide la consigna: el **subconjunto del protocolo SNMP** implementado, el **manejo de
credenciales SSH** y el **diseño de la cola offline** (outbox). Al principio se explica la arquitectura y por qué se apartó del
stack sugerido.

---

## 1. Arquitectura

```
┌──────────────────────── App (Expo / React Native) ────────────────────────┐
│ Presentación: Expo Router (pestañas Red · SNMP · SSH · Instalaciones ·      │
│               Historial · Sync)                                            │
│ Evidence:  expo-camera (QR/barras + fotos) · expo-location · image-manip.  │
│ Local Store: almacén en memoria persistido en AsyncStorage (por colección) │
│ Sync Layer: outbox persistida + NetInfo + backoff + resolución conflictos  │
│ Reporting: HTML → PDF (expo-print en mobile; diálogo de impresión en web)  │
└───────────────┬────────────────────────────────────────────────────────────┘
                │ HTTP (JSON) dentro de la LAN
┌───────────────▼──────────────── NDS Agent (Node, server/) ─────────────────┐
│ Discovery: sondas TCP/UDP a la subred → tabla ARP · mDNS (paquetes DNS      │
│            propios) · NetBIOS NBSTAT · DNS inverso · tabla OUI offline     │
│ Protocol:  SNMP v1/v2c (BER/ASN.1 + PDU + cliente UDP propios) · SSH (ssh2) │
│ Sync backend: idempotencia por opId + LWW por updatedAt (JSON en disco)     │
│ Laboratorio: agente SNMP simulado (UDP/1161) y servidor SSH (TCP/2222)      │
└──────────┬─────────────────────────────┬───────────────────────────────────┘
           │ UDP/161, TCP/22, ARP, mDNS  │
      Equipos de la red local       Backend de sincronización
```

### Decisión: agente de red en lugar de sockets dentro de la app

El stack sugerido (`react-native-udp`, `react-native-tcp-socket`, `react-native-ssh-sftp`, `react-native-zeroconf`) son módulos
nativos: **no funcionan en Expo Go ni en un navegador**. La entrega se graba en web, y un navegador, por diseño de seguridad, no
puede emitir datagramas UDP ni abrir conexiones TCP arbitrarias. Por eso la capa de protocolos se movió a un agente Node que corre
en la misma LAN:

- La lógica de protocolo **sigue siendo propia y de bajo nivel**: SNMP sobre `node:dgram` (UDP crudo) con codificador BER
  escrito a mano, mDNS y NetBIOS con paquetes construidos byte a byte, y sondas con `node:net`.
- La app mantiene la arquitectura en capas pedida. En un build nativo (APK), la capa Protocol podría reemplazarse por los módulos
  nativos sin tocar la UI, porque las pantallas solo dependen de `mobile/src/lib/agent.ts`.
- El agente también cumple el entregable de **backend mínimo de sincronización**.

### Decisión: almacenamiento local

WatermelonDB requiere módulos nativos y configuración de Babel con decoradores, y en web depende de LokiJS. Se optó por un almacén
propio (`mobile/src/lib/store.ts`) con las mismas propiedades que importan para el TP:

- **Reactivo**: las pantallas se suscriben con `useSyncExternalStore` y se actualizan solas cuando cambia un dato, por ejemplo
  cuando la sincronización adopta la versión del servidor.
- **Persistente por colección** (`devices`, `diagnostics`, `installations`, `outbox`, …) en AsyncStorage: localStorage en web,
  almacenamiento nativo en Android/iOS.
- **La UI nunca lee de la red**: todo se muestra desde el almacén, así que el historial (RF-08) funciona sin conexión.
- La outbox se escribe a disco **inmediatamente**. El resto de las colecciones se agrupa en escrituras cada 150 ms, y al ocultar o
  cerrar la pestaña se fuerza el guardado.

Límite conocido: en web, localStorage admite unos 5-10 MB. Por eso las fotos se reducen a ≤960 px en JPEG calidad 0.6 (unos
60-120 KB cada una).

---

## 2. Subconjunto de SNMP implementado

Código: `server/src/snmp/ber.ts`, `pdu.ts`, `client.ts`, `mib.ts`. Referencias: RFC 1157 (SNMPv1), RFC 3416 (PDUs v2c),
RFC 2578 (tipos SMIv2), RFC 1213 (MIB-II), X.690 (BER).

### 2.1 Codificación BER

Cada valor es un TLV: `tag (1 byte) | longitud | valor`.

| Elemento | Implementación |
|---|---|
| Longitud | Forma corta (< 128) y forma larga `0x8N` + N bytes (hasta 4). No se admite longitud indefinida (SNMP no la usa). |
| INTEGER (0x02) | Complemento a dos con la mínima cantidad de bytes (`128` → `02 02 00 80`, `-1` → `02 01 FF`). |
| OCTET STRING (0x04) | Bytes crudos. Al decodificar se muestra como texto si es UTF-8 imprimible y como `aa:bb:…` si es binario (ej. MAC). |
| NULL (0x05) | `05 00`, usado como valor de los varbinds en los GetRequest. |
| OBJECT IDENTIFIER (0x06) | Primeros dos arcos como `40·X+Y` y el resto en base 128 con bit de continuación (`1.3.6.1.2.1.1.1.0` → `06 08 2B 06 01 02 01 01 01 00`). |
| SEQUENCE (0x30) | Mensaje, lista de varbinds y cada varbind. |
| IpAddress (0x40), Counter32 (0x41), Gauge32 (0x42), TimeTicks (0x43), Opaque (0x44), Counter64 (0x46) | Enteros sin signo (con `0x00` inicial si el bit alto está encendido). Los contadores se representan como `bigint`/string para no perder precisión. |
| noSuchObject (0x80), noSuchInstance (0x81), endOfMibView (0x82) | Excepciones de v2c, decodificadas como valores especiales y no como errores. |

### 2.2 Mensaje y PDUs

```
Message ::= SEQUENCE { version INTEGER (0=v1, 1=v2c), community OCTET STRING, PDU }
PDU     ::= [A0|A1|A2] { request-id INTEGER, error-status INTEGER, error-index INTEGER,
                          varbinds SEQUENCE OF SEQUENCE { OID, valor } }
```

- **Se envían:** `GetRequest` (0xA0) y `GetNextRequest` (0xA1).
- **Se reciben:** `GetResponse` (0xA2). Se valida tipo de cada TLV, versión y que el `request-id` coincida con el enviado.
  Las respuestas con otro `request-id` (viejas o ajenas) se descartan.
- **Errores:** `error-status` ≠ 0 se traduce a su nombre (`noSuchName`, `tooBig`, `genErr`…) indicando el OID culpable mediante
  `error-index`.
- **Fuera de alcance:** `SetRequest`, `GetBulkRequest`, Traps/Informs y todo SNMPv3 (USM, autenticación y cifrado).

Prueba de conformidad (`server/test/snmp.test.ts`): el GetRequest generado para `sysDescr.0` con request-id 1 es **byte a byte
idéntico** al que produce `snmpget -v2c -c public` de net-snmp.

### 2.3 Cliente UDP

- Socket UDP efímero por petición. Timeout configurable (2 s por defecto) y reintentos (1 por defecto), con un nuevo `request-id`
  aleatorio en cada intento.
- Como máximo 10 OIDs por PDU, para evitar `tooBig` en equipos con buffers chicos.
- Cada intercambio queda registrado como **traza hexadecimal** (petición, respuesta y RTT), y la app la muestra en
  "Paquetes SNMP en crudo".

### 2.4 Consultas de alto nivel (MIB-II)

| Consulta | OIDs |
|---|---|
| Sistema | `sysDescr` .1.1.0 · `sysObjectID` .1.2.0 · `sysUpTime` .1.3.0 (TimeTicks → `Nd hh:mm:ss`) · `sysContact` .1.4.0 · `sysName` .1.5.0 · `sysLocation` .1.6.0 |
| Interfaces | `ifNumber` .2.1.0 y un *walk* con GetNext sobre `ifDescr` (.2.2.1.2) para descubrir los `ifIndex` reales (no se asume 1..N). Luego se leen `ifSpeed`, `ifPhysAddress`, `ifAdminStatus`, `ifOperStatus`, `ifInOctets`, `ifOutOctets`, `ifInErrors`, `ifOutErrors`. |
| Tráfico | Dos muestras de `ifIn/OutOctets` separadas 2 s: `bps = Δoctetos·8 / Δt`. Si el Counter32 dio la vuelta (`b < a`), se suma 2³². |

El walk corta al salir del subárbol, al recibir `endOfMibView` o si el agente devuelve un OID que no avanza (evita bucles con
agentes defectuosos). Tiene un tope de 32 elementos.

### 2.5 Limitaciones de seguridad (explícitas)

- SNMP v1/v2c **no tiene autenticación real**: la community viaja **en texto plano** dentro de cada datagrama UDP. Cualquiera en
  el mismo segmento puede capturarla.
- No hay integridad ni confidencialidad: las respuestas pueden falsificarse (spoofing UDP). La validación del `request-id` solo
  mitiga respuestas accidentales, no ataques.
- Por eso la herramienta es **de solo lectura**: no implementa `SetRequest`. Se recomienda usar communities de solo lectura y
  restringir SNMP a la VLAN de gestión. Para producción correspondería SNMPv3 con authPriv (fuera de alcance).
- La community no se persiste en el dispositivo como secreto. Se ingresa por consulta, con `public` como valor por defecto.

---

## 3. Manejo de credenciales SSH

Código: `mobile/src/lib/credentials.ts`, `server/src/ssh/client.ts`, `server/src/ssh/commands.ts`.

### 3.1 Almacenamiento: nunca en texto plano

| Plataforma | Dónde se guarda la contraseña (si el técnico activa "Recordar") |
|---|---|
| Android | `expo-secure-store` → **Android Keystore** (cifrado con clave de hardware) |
| iOS | `expo-secure-store` → **Keychain**, con `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (no se respalda ni migra a otro equipo) |
| Web | El navegador no tiene un almacén equivalente: la contraseña se guarda **solo en memoria** durante la sesión y se pierde al recargar. Nunca va a localStorage. |

Además:

- La clave del llavero es `nds_cred_<host>_<puerto>`, así que cada equipo tiene su propia credencial.
- La contraseña **no forma parte de ningún diagnóstico**: el registro SSH guarda comando, salida, código de salida, usuario y
  huella del host. Por lo tanto **nunca entra en la outbox** ni llega al backend.
- En el agente, la contraseña llega en el cuerpo del request, se usa para autenticar y se descarta. No se loguea ni se escribe a
  disco.
- El botón "Olvidar" borra la credencial del llavero.

### 3.2 Verificación del host (TOFU)

En la primera conexión, el agente calcula la huella `SHA256:<base64>` de la clave pública del servidor y la app la guarda como
host conocido. En las conexiones siguientes la app envía `expectedFingerprint`: si la huella cambió, el agente **aborta la
conexión antes de autenticarse**, sin enviar la contraseña, y avisa de un posible MITM o de un equipo reemplazado. El técnico
puede "Olvidar huella" si el cambio es legítimo.

### 3.3 Comandos predefinidos

La app nunca envía comandos libres, solo un `commandId`. El agente lo traduce con un catálogo por vendor (Linux/OpenWrt,
Cisco IOS, MikroTik RouterOS, Huawei VRP, Windows OpenSSH) que contiene **únicamente comandos de lectura** (`show …`,
`display …`, `uptime`, `ip route`, …). Así la herramienta no se puede usar como shell remoto arbitrario y un error de tipeo en
campo no puede reconfigurar un equipo. Las salidas se truncan a 64 KB.

### 3.4 Transporte app ↔ agente

En la LAN de laboratorio el tráfico app → agente es HTTP. En un despliegue real debería usarse HTTPS (o que el agente corra en el
mismo dispositivo), porque la contraseña viaja en ese request. Queda documentado como limitación.

---

## 4. Diseño de la cola offline (patrón Outbox)

Código: `mobile/src/lib/outbox.ts` (cliente), `server/src/sync/store.ts` (servidor).

### 4.1 Flujo de escritura

```
acción del técnico ─► almacén local (fuente de verdad de la UI)
                   └► enqueue(op) ─► outbox persistida ─► motor de sync ─► POST /api/sync/push
```

Toda escritura pasa por un repositorio (`saveDevices`, `addDiagnostic`, `saveInstallation`, `recordReport`,
`deleteInstallation`) que **guarda localmente y encola** en un solo paso. La UI responde al instante, con o sin conexión.

### 4.2 Estructura de una operación

```ts
{ opId: uuid,            // clave de idempotencia
  entity: 'device' | 'diagnostic' | 'installation' | 'report',
  entityId, action: 'upsert' | 'delete', payload, updatedAt,
  status: 'pending' | 'syncing' | 'retrying' | 'failed',
  attempts, nextAttemptAt, lastError, bytes, createdAt }
```

### 4.3 Compactación

Si se encola una operación para una entidad que ya tiene otra **pendiente** (no en vuelo), la anterior se reemplaza: solo importa el
último estado. Editar diez veces una instalación offline produce un solo envío. La operación nueva lleva un `opId` nuevo, porque la
anterior pudo haber llegado al servidor con la respuesta perdida, y reutilizar su id haría que el servidor descarte los cambios
nuevos como duplicados.

### 4.4 Disparadores del envío

1. Al encolar (si hay conexión).
2. Al **recuperar conectividad**: evento de `@react-native-community/netinfo`, o al desactivar el "modo sin conexión". En este
   caso se reintenta **inmediatamente** todo lo pendiente, ignorando el backoff.
3. Cada 3 s, para las operaciones cuyo `nextAttemptAt` ya venció.
4. Manualmente, con "Sincronizar ahora".

Solo hay un envío en curso a la vez. Los lotes son de hasta 10 operaciones en orden de creación (FIFO) y, si quedan más
vencidas, se encadena el siguiente lote.

### 4.5 Reintentos

- **Error de red, timeout o 5xx**: se reprograma con **backoff exponencial con jitter**:
  `min(60 s, 2 s · 2^(intentos−1)) · U(0.8, 1.2)`, es decir 2 s, 4 s, 8 s, 16 s, 32 s, 60 s…
- Las operaciones que quedaron en `syncing` porque la app se cerró a mitad de un envío vuelven a `retrying` al iniciar. Si el
  servidor ya las había aplicado, responde `duplicate` y no se aplican dos veces.

### 4.6 Respuesta del servidor por operación

| Resultado | Significado | Acción en el cliente |
|---|---|---|
| `applied` | Se aplicó y se incrementó `serverVersion` | Se quita de la cola |
| `duplicate` | El `opId` ya había sido procesado (reintento) | Se quita de la cola. **Idempotencia**: nunca se aplica dos veces |
| `conflict` | El servidor tiene una versión con `updatedAt` más nuevo | **Gana el servidor**: el cliente adopta su versión, la pantalla se actualiza y avisa |
| `rejected` | Operación inválida | Queda en `failed` (no se reintenta: evita un *poison message* infinito). El técnico puede reintentar o descartar |

### 4.7 Resolución de conflictos

Estrategia **Last-Write-Wins por `updatedAt`**, decidida en el servidor:

- Si `op.updatedAt ≥ registro.updatedAt`, se aplica.
- Si no, se responde `conflict` con el registro del servidor y el cliente lo adopta.

Se puede demostrar desde el panel del backend con "Editar desde oficina" (marca el registro como más nuevo) y luego una edición
offline vieja en la app.

Limitación: LWW depende de los relojes de los dispositivos y resuelve a nivel de registro completo, no por campo. Para un sistema
productivo correspondería usar versiones del servidor (`baseVersion`) y un *merge* por campo.

### 4.8 Detección de conectividad

- `NetInfo` informa si el dispositivo tiene red. Si no la tiene, el motor ni lo intenta.
- La alcanzabilidad real del backend se infiere del resultado de cada envío: con error de red se marca "Backend caído" y se aplica
  el backoff.
- "Modo sin conexión" (pestaña Sync) fuerza el comportamiento offline para simular un sitio sin cobertura sin cortar la LAN, que
  sigue disponible para los diagnósticos.

### 4.9 Backend de sincronización

`POST /api/sync/push` recibe hasta 50 operaciones y responde un resultado por cada una. Guarda los registros y el conjunto de
`opId` aplicados (los últimos 5000) en `server/data/sync-db.json` con escritura atómica (archivo temporal + rename). El panel
`http://localhost:4000/` muestra lo recibido y permite simular fallas del backend (*modo caos*, 50% o 100% de respuestas 503) para
observar los reintentos.

---

## 5. Descubrimiento de red (detalle)

Un proceso sin privilegios no puede emitir tramas ARP crudas. Se usa la técnica clásica:

1. Se envía un datagrama UDP y sondas TCP (puertos 22, 23, 53, 80, 443, 445, 8080, 8291, 7547) a cada IP de la subred, que se
   limita a una /24 alrededor de la IP propia. Para emitir esos paquetes, el sistema operativo **resuelve la MAC por ARP**.
2. Se lee la **tabla ARP del SO** (`arp -a` / `ip neigh`): todo host que respondió a ARP queda listado con su MAC.
3. Las sondas TCP aportan puertos abiertos. Un `ECONNREFUSED` (RST) también prueba que el host está vivo.
4. En paralelo:
   - **mDNS/DNS-SD**: consultas PTR a 224.0.0.251:5353 con paquetes DNS armados a mano y parser con compresión de nombres.
   - **NetBIOS NBSTAT**: UDP/137, para nombres de equipos Windows.
   - **PTR inverso** por mDNS unicast y DNS inverso del sistema.
5. Fabricante por OUI con una tabla embebida (offline). Las MAC con el bit "administrada localmente" se marcan como privadas o
   aleatorias, típicas de celulares.
6. El gateway se toma de la ruta por defecto **de la interfaz escaneada**, para ignorar las rutas de VPNs.

Un escaneo de /24 tarda entre 5 y 10 s.
