# Network Diagnostics Suite (TP6)

Toolkit de diagnóstico de red **offline-first** para técnicos de campo, hecho con **React Native + Expo** (SDK 58, Expo Router).
Descubre equipos en la LAN, los consulta por **SNMP** (paquetes BER/ASN.1 armados a mano), ejecuta diagnósticos por **SSH**,
identifica equipos por **QR**, registra instalaciones con **fotos y GPS**, genera **reportes PDF** y sincroniza todo con una
**cola outbox** que funciona sin conexión.

```
TP6_Network_Diagnostics_Suite/
├── mobile/   App Expo (web, Android, iOS) — UI, almacenamiento local, outbox, reportes
├── server/   NDS Agent: agente de red (scan, SNMP, SSH) + backend de sincronización
└── docs/     Documento técnico (subset SNMP, credenciales SSH, diseño de la cola offline)
```

## ¿Por qué hay un "agente" en Node?

Un navegador (y Expo Go) **no puede abrir sockets UDP/TCP crudos**: no existe forma de mandar un datagrama UDP al puerto 161 ni de
abrir una sesión SSH desde JavaScript en una página web. Por eso las operaciones de bajo nivel corren en `server/`, un proceso Node
en la misma LAN que la app consume por HTTP. El protocolo SNMP **no usa librerías**: el codificador BER, las PDUs y el cliente UDP
están implementados a mano en `server/src/snmp/`.

El mismo proceso hace de **backend mínimo de sincronización** (entregable 4 de la consigna).

## Requisitos

- Node.js 22.18 o superior (probado con Node 24)
- Un navegador (Chrome/Edge). Para la cámara y el GPS la app debe abrirse en `http://localhost` (o HTTPS).

## Cómo correrlo

**Opción rápida (Windows):** doble clic en `iniciar.bat`. Abre dos ventanas (agente + app) y el navegador.

**Manual, en dos terminales:**

```bash
# Terminal 1: agente de red + backend
cd server
npm install
npm start

# Terminal 2: app
cd mobile
npm install
npm run web          # abre http://localhost:8081
```

Al arrancar, el agente muestra:

```
Panel:         http://localhost:4000/        ← backend: lo que llegó por sync
QR de prueba:  http://localhost:4000/qr      ← etiquetas QR de las fichas técnicas
SNMP simulado: <tu IP> UDP/1161  community "public"
SSH simulado:  <tu IP> TCP/2222  tecnico / nds2026
```

### Equipos simulados de laboratorio

La mayoría de los routers hogareños traen SNMP deshabilitado y no exponen SSH. Para poder demostrar el flujo completo, el agente
levanta dos **equipos de laboratorio** que usan los mismos protocolos reales sobre la red:

- **Agente SNMP** en UDP/1161 con una MIB-II mínima (system + ifTable con contadores de tráfico que avanzan). Habla el mismo
  protocolo binario que un equipo real: el cliente no sabe que es simulado.
- **Servidor SSH** en TCP/2222 (usuario `tecnico`, contraseña `nds2026`) que responde a los comandos de diagnóstico con salidas de
  ejemplo. No ejecuta nada en la PC.

En las pantallas SNMP y SSH, el botón **"Usar equipo simulado"** completa IP y puerto. Si tenés un equipo real con SNMP o SSH,
poné su IP y listo. Para desactivar los simuladores: `NO_SIMULATORS=1 npm start`.

## Funcionalidades (requisitos de la consigna)

| ID | Requisito | Dónde |
|---|---|---|
| RF-01 | Escaneo de la LAN: IP, MAC, hostname | Pestaña **Red** · `server/src/discovery/` (sondas TCP/UDP → tabla ARP, mDNS/Bonjour, NetBIOS, DNS inverso) |
| RF-02 | SNMP: uptime, sysName, tráfico de interfaces | Pestaña **SNMP** · `server/src/snmp/` (BER + PDU v1/v2c propios) |
| RF-03 | SSH con comandos predefinidos | Pestaña **SSH** · `server/src/ssh/` (catálogo por vendor, verificación de huella TOFU) |
| RF-04 | QR/barras → ficha técnica remota | Detalle de equipo e instalación · `mobile/src/app/scanner.tsx` |
| RF-05 | Instalación con fotos, GPS y notas | Pestaña **Instalaciones** |
| RF-06 | Reporte PDF | Botón **Generar reporte PDF** (web: diálogo de impresión → "Guardar como PDF") |
| RF-07 | Offline-first + cola diferida | Pestaña **Sync** · `mobile/src/lib/outbox.ts` + `server/src/sync/store.ts` |
| RF-08 | Historial por equipo/sitio sin conexión | Pestaña **Historial** |

## Guion sugerido para el video demo

1. **Descubrimiento**: pestaña *Red* → *Escanear red*. Se listan los equipos reales de la LAN (router, celulares, TV…) con MAC y
   hostname. Tocá uno para ver el detalle.
2. **SNMP**: pestaña *SNMP* → *Usar equipo simulado* (o la IP de un equipo real) → *Consultar sistema* (sysName, uptime) →
   *Tráfico de interfaces*. Abrí *Paquetes SNMP en crudo* para mostrar el GetRequest/GetResponse en hexadecimal.
3. **SSH** (opcional): *Usar equipo simulado*, contraseña `nds2026`, ejecutá *Uptime y carga*.
4. **Instalación**: *Instalaciones* → *Nueva instalación*. Completá sitio/cliente/notas, *Capturar ubicación*, *Escanear QR del
   equipo* (mostrá a la webcam una etiqueta de `http://localhost:4000/qr` desde el celular, o usá *Leer código desde una imagen* /
   ingreso manual `NDS-ONT-0001`), *Tomar foto* con la webcam, asociá equipos relevados, *Guardar*.
5. **PDF**: *Generar reporte PDF* → *Guardar como PDF*. Abrí el PDF y mostrá la foto con sus coordenadas y el mapa.
6. **Sync tras recuperar conectividad**:
   - Pestaña *Sync* → activá **Modo sin conexión** (o cortá el Wi-Fi, o en DevTools → Network → *Offline*).
   - Editá la instalación o creá otra: el indicador de arriba muestra "Sin conexión · N en cola" y la cola crece.
   - Mostrá el panel del backend (`http://localhost:4000/`): todavía no llegó.
   - Desactivá el modo sin conexión: la cola se vacía sola y el panel muestra la instalación con su foto.
   - Extra: en el panel, *Modo caos 100%* hace fallar al backend → se ven los reintentos con backoff. *Editar desde oficina* +
     editar offline en la app → al sincronizar se ve el **conflicto** resuelto (gana la versión más nueva).

## Build Android (APK)

La consigna aclara que el proyecto **no es compatible con Expo Go** (requiere permisos de red local). Para generar un APK de
prueba sin Android Studio:

```bash
cd mobile
npx eas-cli@latest build -p android --profile preview
```

Con el APK, la app usa la misma arquitectura: habla con el agente en la LAN (configurable en *Sync → Ajustes → URL del agente*).

## Tests

```bash
cd server && npm test        # codec BER, PDU idéntica a net-snmp, cliente ↔ agente por UDP real
cd server && npm run typecheck
cd mobile && npm run typecheck
```
