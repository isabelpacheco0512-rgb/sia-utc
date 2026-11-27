import "dotenv/config";
import express from "express";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET = process.env.JWT_SECRET;
if (!SECRET) { console.error("Falta JWT_SECRET en el archivo .env"); process.exit(1); }

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost", port: +(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root", password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "sia_demo",
  dateStrings: true, decimalNumbers: true, connectionLimit: 10
});

/* ---------- utilidades ---------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const fail = (status, message) => Object.assign(new Error(message), { status });
const ah = f => (req, res, next) => Promise.resolve(f(req, res)).catch(next);
const q = async (sql, p = []) => (await pool.query(sql, p))[0];
const tx = async f => {
  const c = await pool.getConnection();
  try { await c.beginTransaction(); const r = await f(c); await c.commit(); return r; }
  catch (e) { await c.rollback(); throw e; } finally { c.release(); }
};
const log = (usuarioId, accion) => q("INSERT INTO bitacora (usuario_id, accion) VALUES (?, ?)", [usuarioId, accion]);
const txt = v => typeof v === "string" && v.trim() !== "";
const nota = v => v === null || v === undefined || v === "" ? null : (Number.isFinite(+v) && +v >= 0 && +v <= 100 ? +v : fail(400, "Calificación fuera de rango (0 a 100)"));
const correoOk = v => /^\S+@\S+\.\S+$/.test(v || "");

const auth = (req, res, next) => {
  try { req.u = jwt.verify((req.headers.authorization || "").replace(/^Bearer /, ""), SECRET); next(); }
  catch { res.status(401).json({ error: "Sesión no válida o vencida" }); }
};
const solo = (...roles) => (req, res, next) =>
  roles.includes(req.u.rol) ? next() : res.status(403).json({ error: "Acceso denegado para tu rol" });

/* ---------- Diagnóstico: abre http://localhost:3000/api/salud ---------- */
app.get("/api/salud", ah(async (req, res) => { await q("SELECT 1"); res.json({ api: "ok", mysql: "ok", base: process.env.DB_NAME || "sia_demo" }); }));

/* ---------- RF-06: acceso con rol y sesión ---------- */
app.post("/api/login", ah(async (req, res) => {
  const usuario = String(req.body.usuario || "").trim(), password = String(req.body.password || "");
  if (!usuario || !password) throw fail(400, "Escribe tu usuario y tu contraseña.");
  const [u] = await q(`SELECT u.* FROM usuarios u LEFT JOIN alumnos a ON a.id = u.alumno_id
                       WHERE u.email = ? OR a.matricula = ? LIMIT 1`, [usuario, usuario]);
  if (!u || !(await bcrypt.compare(password, u.password_hash))) throw fail(401, "Usuario o contraseña incorrectos.");
  if (!u.activo) throw u.token_activacion
    ? fail(403, "Tu cuenta aún no está activada. Abre el enlace que te enviamos a tu correo.")
    : fail(401, "Usuario o contraseña incorrectos.");                     // cuenta desactivada por el administrador
  const datos = { id: u.id, email: u.email, rol: u.rol, alumno_id: u.alumno_id, docente_id: u.docente_id };
  await log(u.id, "Inicio de sesión");
  res.json({ token: jwt.sign(datos, SECRET, { expiresIn: "8h" }), usuario: datos });
}));

/* ---------- Registro con correo de activación ----------
   Se registran alumnos y docentes que ya dio de alta control escolar (matrícula o número de empleado),
   con el correo que quieran (Gmail, Outlook…). La cuenta nace inactiva hasta que abren el enlace. */
// IP de la compu en la red Wi-Fi (ej. 192.168.1.50) para que el enlace del correo abra desde el celular
const ipLocal = () => Object.values(os.networkInterfaces()).flat()
  .find(n => n && n.family === "IPv4" && !n.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(n.address))?.address || "localhost";
// En Railway usa su dominio público; en tu compu, la IP del Wi-Fi
const APP_URL = (process.env.APP_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://${ipLocal()}:${process.env.PORT || 3000}`)).replace(/\/$/, "");
const sha = t => crypto.createHash("sha256").update(t).digest("hex");
const passOk = p => typeof p === "string" && p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p);
let transporte = null;
async function enviarCorreo(para, asunto, html) {
  if (process.env.BREVO_API_KEY) {                                 // en Railway: API de Brevo por HTTPS (SMTP está bloqueado)
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { name: "SIA · Universidad Tecnológica del Centro", email: process.env.MAIL_FROM },
                             to: [{ email: para }], subject: asunto, htmlContent: html })
    });
    if (!r.ok) { console.error("Brevo:", r.status, await r.text()); throw fail(502, "No se pudo enviar el correo. Intenta más tarde."); }
    return;
  }
  if (!process.env.MAIL_USER || !process.env.MAIL_PASS) {          // sin Gmail configurado: el enlace sale en la terminal
    console.log(`\n[CORREO DE PRUEBA] Para: ${para}\nAsunto: ${asunto}\n${html.match(/href="([^"]+)"/)?.[1] || ""}\n`);
    return;
  }
  if (!transporte) {
    const nodemailer = (await import("nodemailer")).default;
    transporte = nodemailer.createTransport({ service: "gmail", auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS } });
  }
  await transporte.sendMail({ from: `"SIA · Universidad Tecnológica del Centro" <${process.env.MAIL_USER}>`, to: para, subject: asunto, html });
}
async function mandarActivacion(usuarioId, correo, nombre) {
  const token = crypto.randomBytes(32).toString("hex");           // va en el enlace; en la base solo se guarda su hash
  await q("UPDATE usuarios SET token_activacion = ?, token_expira = DATE_ADD(NOW(), INTERVAL 24 HOUR) WHERE id = ?", [sha(token), usuarioId]);
  const link = `${APP_URL}/api/activar?token=${token}`;
  await enviarCorreo(correo, "Activa tu cuenta del SIA", `
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:auto;border-top:6px solid #3B6FB6;background:#F8F6FD;padding:28px;color:#2E2B4F">
      <h1 style="margin:0 0 4px;letter-spacing:.06em">SIA</h1>
      <p style="margin:0 0 20px;color:#5C5A7A">Universidad Tecnológica del Centro</p>
      <p>Hola, ${String(nombre).replace(/[<>&"]/g, "")}:</p>
      <p>Recibimos tu registro en el Sistema de Información Académico. Para activar tu cuenta da clic en el botón:</p>
      <p style="text-align:center;margin:28px 0"><a href="${link}" style="background:#CDEFE0;color:#1D5A41;padding:14px 26px;border-radius:4px;text-decoration:none;font-weight:700">Activar mi cuenta</a></p>
      <p style="font-size:13px;color:#5C5A7A">El enlace vence en 24 horas. Si tú no te registraste, ignora este correo.</p>
    </div>`);
}

// Programas para el formulario de registro (público, sin sesión)
app.get("/api/programas", ah(async (req, res) => res.json(await q("SELECT id, nombre FROM programas ORDER BY nombre"))));

app.post("/api/registro", ah(async (req, res) => {
  const { tipo, password } = req.body, correo = String(req.body.correo || "").trim().toLowerCase();
  const identificador = String(req.body.identificador || "").trim(), nombres = String(req.body.nombres || "").trim(), apellidos = String(req.body.apellidos || "").trim();
  if (!["ALUMNO", "DOCENTE"].includes(tipo) || !identificador || !nombres || !apellidos) throw fail(400, "Completa todos los campos.");
  if (!/^[A-Za-z0-9-]{3,20}$/.test(identificador)) throw fail(400, "La matrícula o número de empleado solo lleva letras, números o guiones (3 a 20).");
  if (!correoOk(correo)) throw fail(400, "Escribe un correo válido.");
  if (!passOk(password)) throw fail(400, "La contraseña debe tener mínimo 8 caracteres, con letras y números.");
  const alumno = tipo === "ALUMNO", col = alumno ? "alumno_id" : "docente_id";
  const [otro] = await q("SELECT id, alumno_id, docente_id FROM usuarios WHERE email = ?", [correo]);

  const r = await tx(async c => {
    // 1. Busca la matrícula / número de empleado; si no existe, lo da de alta
    let [[p]] = alumno
      ? await c.query("SELECT id, nombres AS nombre, estatus FROM alumnos WHERE matricula = ? FOR UPDATE", [identificador])
      : await c.query("SELECT id, nombre FROM docentes WHERE numero_empleado = ? FOR UPDATE", [identificador]);
    if (p?.estatus === "INACTIVO") throw fail(403, "Esa matrícula está dada de baja. Acude a control escolar.");
    if (!p) {
      if (alumno) {
        const [[prog]] = await c.query("SELECT id FROM programas WHERE id = ?", [+req.body.programa_id || 0]);
        if (!prog) throw fail(400, "Elige tu carrera.");
        const [[dup]] = await c.query("SELECT 1 AS x FROM alumnos WHERE correo = ?", [correo]);
        if (dup) throw fail(409, "Ese correo ya pertenece a otro alumno. Usa otro.");
        const [ins] = await c.query("INSERT INTO alumnos (matricula, nombres, apellidos, correo, programa_id, estatus) VALUES (?,?,?,?,?, 'ACTIVO')",
          [identificador, nombres, apellidos, correo, prog.id]);
        p = { id: ins.insertId, nombre: nombres };
      } else {
        const [[dup]] = await c.query("SELECT 1 AS x FROM docentes WHERE correo = ?", [correo]);
        if (dup) throw fail(409, "Ese correo ya pertenece a otro docente. Usa otro.");
        const [ins] = await c.query("INSERT INTO docentes (numero_empleado, nombre, correo) VALUES (?,?,?)", [identificador, `${nombres} ${apellidos}`, correo]);
        p = { id: ins.insertId, nombre: nombres };
      }
    }
    // 2. Crea (o actualiza, si nunca activó) la cuenta de acceso
    const [[ya]] = await c.query(`SELECT id, activo FROM usuarios WHERE ${col} = ?`, [p.id]);
    if (ya?.activo) throw fail(409, `Ya existe una cuenta para ${alumno ? "esa matrícula" : "ese número de empleado"}. Inicia sesión.`);
    if (otro && otro.id !== ya?.id) throw fail(409, "Ese correo ya está registrado. Usa otro o inicia sesión.");
    const hash = await bcrypt.hash(password, 10);
    let id = ya?.id;
    if (id) await c.query("UPDATE usuarios SET email = ?, password_hash = ? WHERE id = ?", [correo, hash, id]);
    else id = (await c.query(`INSERT INTO usuarios (email, password_hash, rol, ${col}, activo) VALUES (?, ?, ?, ?, 0)`, [correo, hash, tipo, p.id]))[0].insertId;
    return { id, nombre: p.nombre };
  });

  await mandarActivacion(r.id, correo, r.nombre);
  await log(r.id, `Registro de cuenta ${tipo.toLowerCase()} ${identificador} (pendiente de activar)`);
  res.status(201).json({ ok: true, mensaje: "Te enviamos un correo para activar tu cuenta." });
}));

const ultimoReenvio = new Map();
app.post("/api/registro/reenviar", ah(async (req, res) => {
  const correo = String(req.body.correo || "").trim().toLowerCase();
  const mensaje = "Si hay una cuenta pendiente con ese correo, te enviamos un enlace nuevo.";   // no revela si el correo existe
  if (Date.now() - (ultimoReenvio.get(correo) || 0) < 60000) throw fail(429, "Espera un minuto antes de pedir otro correo.");
  ultimoReenvio.set(correo, Date.now());
  const [u] = await q(`SELECT u.id, COALESCE(a.nombres, d.nombre) AS nombre FROM usuarios u
      LEFT JOIN alumnos a ON a.id = u.alumno_id LEFT JOIN docentes d ON d.id = u.docente_id
      WHERE u.email = ? AND u.activo = 0 AND u.token_activacion IS NOT NULL`, [correo]);
  if (u) await mandarActivacion(u.id, correo, u.nombre);
  res.json({ ok: true, mensaje });
}));

app.get("/api/activar", ah(async (req, res) => {
  const token = String(req.query.token || "");
  const [u] = /^[a-f0-9]{64}$/.test(token)
    ? await q("SELECT id FROM usuarios WHERE token_activacion = ? AND token_expira > NOW() AND activo = 0", [sha(token)]) : [];
  if (!u) return res.redirect("/?activada=0");
  await q("UPDATE usuarios SET activo = 1, token_activacion = NULL, token_expira = NULL WHERE id = ?", [u.id]);
  await log(u.id, "Cuenta activada desde el correo");
  res.redirect("/?activada=1");
}));

/* ---------- Datos que necesita la interfaz, filtrados por rol ---------- */
app.get("/api/datos", auth, ah(async (req, res) => {
  const { rol, alumno_id, docente_id } = req.u, admin = rol === "ADMIN";
  const d = {
    programas: await q("SELECT id, clave, nombre FROM programas"),
    materias: await q("SELECT id, clave, nombre, creditos, programa_id FROM materias"),
    periodos: await q("SELECT id, nombre, fecha_inicio, fecha_fin FROM periodos ORDER BY fecha_inicio, id"),
    docentes: await q(`SELECT ${admin ? "id, numero_empleado, nombre, correo" : "id, nombre"} FROM docentes`)
  };
  const alcance = { ADMIN: ["1=1", []], DOCENTE: ["docente_id = ?", [docente_id]],
    ALUMNO: ["id IN (SELECT grupo_id FROM inscripciones WHERE alumno_id = ? AND estatus = 'INSCRITO')", [alumno_id]] }[rol];
  d.grupos = await q(`SELECT id, clave, materia_id, docente_id, periodo_id, cupo FROM grupos WHERE ${alcance[0]}`, alcance[1]);
  const gids = d.grupos.map(g => g.id);
  d.horarios = gids.length ? await q(`SELECT id, grupo_id, dia_semana, TIME_FORMAT(hora_inicio,'%H:%i') AS hora_inicio,
      TIME_FORMAT(hora_fin,'%H:%i') AS hora_fin, aula FROM horarios WHERE grupo_id IN (?)`, [gids]) : [];
  d.inscripciones = rol === "ALUMNO"
    ? await q("SELECT id, alumno_id, grupo_id, fecha, estatus FROM inscripciones WHERE alumno_id = ?", [alumno_id])
    : gids.length || admin ? await q(`SELECT id, alumno_id, grupo_id, fecha, estatus FROM inscripciones ${admin ? "" : "WHERE grupo_id IN (?)"}`, [gids]) : [];
  const iids = d.inscripciones.map(i => i.id), aids = [...new Set(d.inscripciones.map(i => i.alumno_id))];
  d.calificaciones = iids.length ? await q("SELECT id, inscripcion_id, parcial1, parcial2, final FROM calificaciones WHERE inscripcion_id IN (?)", [iids]) : [];
  d.alumnos = admin ? await q("SELECT id, matricula, nombres, apellidos, correo, programa_id, estatus FROM alumnos")
    : aids.length ? await q("SELECT id, matricula, nombres, apellidos, programa_id, estatus FROM alumnos WHERE id IN (?)", [aids]) : [];
  d.bitacora = admin ? await q(`SELECT DATE_FORMAT(b.fecha,'%d/%m/%Y %H:%i') AS f, COALESCE(u.email,'—') AS u, b.accion AS a
      FROM bitacora b LEFT JOIN usuarios u ON u.id = b.usuario_id ORDER BY b.id DESC LIMIT 200`) : [];
  res.json(d);
}));

/* ---------- RF-01: alumnos ---------- */
const alumnoOk = b => {
  if (![b.matricula, b.nombres, b.apellidos].every(txt) || !correoOk(b.correo)) throw fail(400, "Completa todos los campos con datos válidos.");
  if (!["ACTIVO", "INACTIVO"].includes(b.estatus || "ACTIVO")) throw fail(400, "Estatus no válido.");
  return [b.matricula.trim(), b.nombres.trim(), b.apellidos.trim(), b.correo.trim(), +b.programa_id, b.estatus || "ACTIVO"];
};
app.get("/api/alumnos", auth, solo("ADMIN"), ah(async (req, res) => {
  const t = `%${req.query.q || ""}%`;
  res.json(await q(`SELECT id, matricula, nombres, apellidos, correo, programa_id, estatus FROM alumnos
    WHERE (matricula LIKE ? OR CONCAT(nombres,' ',apellidos) LIKE ?) AND (? = '' OR programa_id = ?) ORDER BY apellidos, nombres`,
    [t, t, req.query.programaId || "", req.query.programaId || 0]));
}));
app.post("/api/alumnos", auth, solo("ADMIN"), ah(async (req, res) => {
  const v = alumnoOk(req.body);
  const [r] = await pool.query("INSERT INTO alumnos (matricula, nombres, apellidos, correo, programa_id, estatus) VALUES (?,?,?,?,?,?)", v);
  await log(req.u.id, `Alta de alumno ${v[0]}`); res.status(201).json({ id: r.insertId });
}));
app.put("/api/alumnos/:id", auth, solo("ADMIN"), ah(async (req, res) => {
  const v = alumnoOk(req.body);
  const [r] = await pool.query("UPDATE alumnos SET matricula=?, nombres=?, apellidos=?, correo=?, programa_id=?, estatus=? WHERE id=?", [...v, req.params.id]);
  if (!r.affectedRows) throw fail(404, "Alumno no encontrado");
  await log(req.u.id, `Edición de alumno ${v[0]}`); res.json({ ok: true });
}));
app.delete("/api/alumnos/:id", auth, solo("ADMIN"), ah(async (req, res) => {   // baja lógica
  await tx(async c => {
    await c.query("UPDATE alumnos SET estatus='INACTIVO' WHERE id=?", [req.params.id]);
    await c.query("UPDATE inscripciones SET estatus='BAJA' WHERE alumno_id=?", [req.params.id]);
  });
  await log(req.u.id, `Baja lógica de alumno #${req.params.id}`); res.json({ ok: true });
}));

/* ---------- RF-02: inscripciones (cupo, doble inscripción y choque los valida sp_inscribir) ---------- */
app.get("/api/inscripciones", auth, solo("ADMIN"), ah(async (req, res) => {
  res.json(await q(`SELECT i.id, i.alumno_id, i.grupo_id, i.fecha, i.estatus FROM inscripciones i JOIN grupos g ON g.id = i.grupo_id
    WHERE (? = '' OR i.alumno_id = ?) AND (? = '' OR g.periodo_id = ?)`,
    [req.query.alumnoId || "", req.query.alumnoId || 0, req.query.periodoId || "", req.query.periodoId || 0]));
}));
app.post("/api/inscripciones", auth, solo("ADMIN"), ah(async (req, res) => {
  const { alumno_id, grupo_ids } = req.body;
  if (!Number.isInteger(alumno_id) || !Array.isArray(grupo_ids) || !grupo_ids.length) throw fail(400, "Elige un alumno y al menos un grupo.");
  const hechos = [];
  for (const g of grupo_ids) {
    try { await pool.query("CALL sp_inscribir(?, ?)", [alumno_id, g]); hechos.push(g); }
    catch (e) {
      if (e.errno === 1644) return res.status(409).json({ error: e.sqlMessage, inscritos: hechos });
      throw e;
    }
  }
  await log(req.u.id, `Inscripción del alumno #${alumno_id} en ${hechos.length} grupo(s)`);
  res.status(201).json({ inscritos: hechos });
}));
app.put("/api/inscripciones/:id/baja", auth, solo("ADMIN"), ah(async (req, res) => {
  await q("UPDATE inscripciones SET estatus='BAJA' WHERE id=?", [req.params.id]);
  await log(req.u.id, `Baja de inscripción #${req.params.id}`); res.json({ ok: true });
}));

/* ---------- Grupos y cargas académicas ---------- */
const choqueDocente = async (docente, periodo, dias, ini, fin, excluir = 0) =>
  (await q(`SELECT 1 FROM horarios h JOIN grupos g ON g.id = h.grupo_id WHERE g.docente_id = ? AND g.periodo_id = ? AND g.id <> ?
            AND h.dia_semana IN (?) AND h.hora_inicio < ? AND ? < h.hora_fin LIMIT 1`, [docente, periodo, excluir, dias, fin, ini])).length > 0;
app.get("/api/grupos", auth, ah(async (req, res) => {
  const { rol, alumno_id, docente_id } = req.u;
  const f = { ADMIN: ["1=1", []], DOCENTE: ["g.docente_id = ?", [docente_id]],
    ALUMNO: ["g.id IN (SELECT grupo_id FROM inscripciones WHERE alumno_id = ? AND estatus='INSCRITO')", [alumno_id]] }[rol];
  res.json(await q(`SELECT g.id, g.clave, g.materia_id, g.docente_id, g.periodo_id, g.cupo,
    (SELECT COUNT(*) FROM inscripciones i WHERE i.grupo_id = g.id AND i.estatus='INSCRITO') AS inscritos FROM grupos g WHERE ${f[0]}`, f[1]));
}));
app.post("/api/grupos", auth, solo("ADMIN"), ah(async (req, res) => {
  const b = req.body, dias = Array.isArray(b.dias) ? b.dias : [];
  if (!txt(b.clave) || !(+b.cupo > 0) || !dias.length || !b.hora_inicio || !b.hora_fin || b.hora_fin <= b.hora_inicio || !txt(b.aula))
    throw fail(400, "Completa los datos del grupo (cupo mayor a 0 y fin posterior al inicio).");
  if (await choqueDocente(b.docente_id, b.periodo_id, dias, b.hora_inicio, b.hora_fin)) throw fail(409, "El docente tiene choque de horario.");
  const id = await tx(async c => {
    const [r] = await c.query("INSERT INTO grupos (clave, materia_id, docente_id, periodo_id, cupo) VALUES (?,?,?,?,?)",
      [b.clave.trim(), b.materia_id, b.docente_id, b.periodo_id, +b.cupo]);
    for (const d of dias) await c.query("INSERT INTO horarios (grupo_id, dia_semana, hora_inicio, hora_fin, aula) VALUES (?,?,?,?,?)",
      [r.insertId, d, b.hora_inicio, b.hora_fin, b.aula.trim()]);
    return r.insertId;
  });
  await log(req.u.id, `Alta de grupo ${b.clave.trim()}`); res.status(201).json({ id });
}));
app.put("/api/grupos/:id", auth, solo("ADMIN"), ah(async (req, res) => {          // reasignar docente
  const hs = await q("SELECT dia_semana, hora_inicio, hora_fin FROM horarios WHERE grupo_id = ?", [req.params.id]);
  const [g] = await q("SELECT periodo_id FROM grupos WHERE id = ?", [req.params.id]);
  if (!g) throw fail(404, "Grupo no encontrado");
  for (const h of hs) if (await choqueDocente(req.body.docente_id, g.periodo_id, [h.dia_semana], h.hora_inicio, h.hora_fin, +req.params.id))
    throw fail(409, "El docente tiene choque de horario.");
  await q("UPDATE grupos SET docente_id = ? WHERE id = ?", [req.body.docente_id, req.params.id]);
  await log(req.u.id, `Docente reasignado en el grupo #${req.params.id}`); res.json({ ok: true });
}));

/* ---------- RF-03: calificaciones ---------- */
app.get("/api/calificaciones/:inscripcionId", auth, ah(async (req, res) => {
  const [i] = await q(`SELECT i.alumno_id, g.docente_id FROM inscripciones i JOIN grupos g ON g.id = i.grupo_id WHERE i.id = ?`, [req.params.inscripcionId]);
  if (!i) throw fail(404, "Inscripción no encontrada");
  if ((req.u.rol === "ALUMNO" && i.alumno_id !== req.u.alumno_id) || (req.u.rol === "DOCENTE" && i.docente_id !== req.u.docente_id)) throw fail(403, "Acceso denegado");
  const [c] = await q("SELECT parcial1, parcial2, final FROM calificaciones WHERE inscripcion_id = ?", [req.params.inscripcionId]);
  res.json(c || { parcial1: null, parcial2: null, final: null });
}));
app.put("/api/calificaciones/:inscripcionId", auth, solo("DOCENTE"), ah(async (req, res) => {
  const [i] = await q(`SELECT g.docente_id FROM inscripciones i JOIN grupos g ON g.id = i.grupo_id WHERE i.id = ?`, [req.params.inscripcionId]);
  if (!i) throw fail(404, "Inscripción no encontrada");
  if (i.docente_id !== req.u.docente_id) throw fail(403, "Acceso denegado: grupo ajeno");
  const p1 = nota(req.body.parcial1), p2 = nota(req.body.parcial2);
  const fin = p1 !== null && p2 !== null ? Math.round(((p1 + p2) / 2) * 100) / 100 : null;   // final = promedio de los dos parciales
  const v = [p1, p2, fin];
  await q(`INSERT INTO calificaciones (inscripcion_id, parcial1, parcial2, final) VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE parcial1 = VALUES(parcial1), parcial2 = VALUES(parcial2), final = VALUES(final)`, [req.params.inscripcionId, ...v]);
  await log(req.u.id, `Calificaciones capturadas en la inscripción #${req.params.inscripcionId}`); res.json({ ok: true });
}));

/* ---------- RF-04: horarios ---------- */
app.get("/api/horarios", auth, ah(async (req, res) => {
  const w = ["1=1"], p = [], { rol, alumno_id, docente_id } = req.u;
  const alumnoId = rol === "ALUMNO" ? alumno_id : req.query.alumnoId;
  if (req.query.grupoId) { w.push("v.grupo_id = ?"); p.push(req.query.grupoId); }
  if (alumnoId) { w.push("v.grupo_id IN (SELECT grupo_id FROM inscripciones WHERE alumno_id = ? AND estatus='INSCRITO')"); p.push(alumnoId); }
  if (rol === "DOCENTE") { w.push("v.grupo_id IN (SELECT id FROM grupos WHERE docente_id = ?)"); p.push(docente_id); }
  res.json(await q(`SELECT v.grupo, v.materia, v.docente, v.dia_semana, TIME_FORMAT(v.hora_inicio,'%H:%i') AS hora_inicio,
    TIME_FORMAT(v.hora_fin,'%H:%i') AS hora_fin, v.aula FROM v_horarios v WHERE ${w.join(" AND ")}
    ORDER BY v.grupo, FIELD(v.dia_semana,'LUN','MAR','MIE','JUE','VIE','SAB'), v.hora_inicio`, p));
}));

/* ---------- RF-05: reportes ---------- */
app.get("/api/reportes", auth, solo("ADMIN"), ah(async (req, res) => {
  if (!req.query.periodoId) throw fail(400, "Indica periodoId");
  res.json(await q(`SELECT periodo, programa, inscritos, promedio FROM v_reporte_periodo_programa
    WHERE periodo_id = ? AND (? = '' OR programa_id = ?)`, [req.query.periodoId, req.query.programaId || "", req.query.programaId || 0]));
}));

/* ---------- RF-09: catálogos ---------- */
const CAT = { programas: ["clave", "nombre"], materias: ["clave", "nombre", "creditos", "programa_id"],
  periodos: ["nombre", "fecha_inicio", "fecha_fin"], docentes: ["numero_empleado", "nombre", "correo"] };
const cat = (req, res, next) => CAT[req.params.t] ? next() : res.status(404).json({ error: "Catálogo inexistente" });
const catOk = (t, b) => {
  const cols = CAT[t];
  if (!cols.every(c => b[c] !== undefined && String(b[c]).trim() !== "")) throw fail(400, "Completa todos los campos.");
  if (t === "materias" && !(Number.isInteger(+b.creditos) && +b.creditos > 0)) throw fail(400, "Los créditos deben ser un entero mayor a 0.");
  if (t === "periodos" && b.fecha_fin < b.fecha_inicio) throw fail(400, "La fecha de fin no puede ser anterior a la de inicio.");
  if (t === "docentes" && !correoOk(b.correo)) throw fail(400, "Correo no válido.");
  return cols.map(c => typeof b[c] === "string" ? b[c].trim() : b[c]);
};
app.get("/api/catalogos/:t", auth, cat, ah(async (req, res) => res.json(await q(`SELECT id, ${CAT[req.params.t].join(", ")} FROM ${req.params.t}`))));
app.post("/api/catalogos/:t", auth, solo("ADMIN"), cat, ah(async (req, res) => {
  const t = req.params.t, v = catOk(t, req.body);
  const [r] = await pool.query(`INSERT INTO ${t} (${CAT[t].join(", ")}) VALUES (?)`, [v]);
  await log(req.u.id, `Alta en ${t}`); res.status(201).json({ id: r.insertId });
}));
app.put("/api/catalogos/:t/:id", auth, solo("ADMIN"), cat, ah(async (req, res) => {
  const t = req.params.t, v = catOk(t, req.body);
  await pool.query(`UPDATE ${t} SET ${CAT[t].map(c => c + " = ?").join(", ")} WHERE id = ?`, [...v, req.params.id]);
  await log(req.u.id, `Edición en ${t} #${req.params.id}`); res.json({ ok: true });
}));
app.delete("/api/catalogos/:t/:id", auth, solo("ADMIN"), cat, ah(async (req, res) => {
  await q(`DELETE FROM ${req.params.t} WHERE id = ?`, [req.params.id]);   // las llaves foráneas bloquean si hay registros relacionados
  await log(req.u.id, `Baja en ${req.params.t} #${req.params.id}`); res.json({ ok: true });
}));

/* ---------- RF-10: bitácora ---------- */
app.get("/api/bitacora", auth, solo("ADMIN"), ah(async (req, res) =>
  res.json(await q(`SELECT DATE_FORMAT(b.fecha,'%d/%m/%Y %H:%i') AS fecha, COALESCE(u.email,'—') AS usuario, b.accion
    FROM bitacora b LEFT JOIN usuarios u ON u.id = b.usuario_id ORDER BY b.id DESC LIMIT 200`))));

/* ---------- EVALUACIÓN DOCENTE (función principal) ----------
   ALUMNO  -> contesta la evaluación de sus docentes (una vez por grupo).
   ADMIN   -> ve resultados de todos, participación, comentarios anónimos y administra la ventana.
   DOCENTE -> ve únicamente SU promedio (sin comentarios ni datos de los alumnos). */
const ventanaDe = async periodoId => {
  const [v] = await q(`SELECT DATE_FORMAT(fecha_apertura,'%Y-%m-%d') AS fecha_apertura, DATE_FORMAT(fecha_cierre,'%Y-%m-%d') AS fecha_cierre,
      (CURDATE() BETWEEN fecha_apertura AND fecha_cierre) AS abierta FROM eval_ventanas WHERE periodo_id = ?`, [periodoId]);
  return v ? { ...v, abierta: !!v.abierta } : null;
};

// Preguntas activas del cuestionario
app.get("/api/evaluaciones/criterios", auth, solo("ALUMNO", "ADMIN"), ah(async (req, res) =>
  res.json(await q("SELECT id, categoria, texto, orden FROM eval_criterios WHERE activo = 1 ORDER BY orden"))));

// Alumno: sus docentes por evaluar (UNA tarjeta por docente y periodo, aunque le dé varias materias)
app.get("/api/evaluaciones/pendientes", auth, solo("ALUMNO"), ah(async (req, res) => {
  const filas = await q(`SELECT d.id AS docente_id, d.nombre AS docente, g.periodo_id,
        GROUP_CONCAT(DISTINCT m.nombre ORDER BY m.nombre SEPARATOR ', ') AS materias,
        GROUP_CONCAT(DISTINCT g.clave ORDER BY g.clave SEPARATOR ', ') AS grupos,
        (SELECT COUNT(*) FROM eval_evaluaciones e WHERE e.alumno_id = ? AND e.docente_id = d.id AND e.periodo_id = g.periodo_id) AS evaluada
      FROM inscripciones i JOIN grupos g ON g.id = i.grupo_id JOIN materias m ON m.id = g.materia_id
      JOIN docentes d ON d.id = g.docente_id
      WHERE i.alumno_id = ? AND i.estatus = 'INSCRITO'
      GROUP BY d.id, d.nombre, g.periodo_id ORDER BY d.nombre`, [req.u.alumno_id, req.u.alumno_id]);
  const cache = {};
  for (const f of filas) {
    cache[f.periodo_id] ??= await ventanaDe(f.periodo_id);
    f.evaluada = f.evaluada > 0; f.ventana = cache[f.periodo_id];
    f.puede_evaluar = !f.evaluada && !!f.ventana?.abierta;
  }
  res.json(filas);
}));

// Alumno: enviar la evaluación de un docente (cubre todas las materias que le da en ese periodo)
app.post("/api/evaluaciones", auth, solo("ALUMNO"), ah(async (req, res) => {
  const { docente_id, periodo_id, respuestas, comentario } = req.body;
  const [ins] = await q(`SELECT 1 AS ok FROM inscripciones i JOIN grupos g ON g.id = i.grupo_id
      WHERE i.alumno_id = ? AND g.docente_id = ? AND g.periodo_id = ? AND i.estatus = 'INSCRITO' LIMIT 1`, [req.u.alumno_id, docente_id, periodo_id]);
  if (!ins) throw fail(403, "Solo puedes evaluar a los docentes que te dan clase en tus grupos inscritos.");
  const [yaHecha] = await q("SELECT 1 AS ok FROM eval_evaluaciones WHERE alumno_id = ? AND docente_id = ? AND periodo_id = ?", [req.u.alumno_id, docente_id, periodo_id]);
  if (yaHecha) throw fail(409, "Ya evaluaste a este docente en este periodo.");
  const v = await ventanaDe(periodo_id);
  if (!v?.abierta) throw fail(409, v ? `La evaluación docente estuvo disponible del ${v.fecha_apertura} al ${v.fecha_cierre}.` : "La evaluación docente aún no está habilitada para este periodo.");
  const crit = await q("SELECT id FROM eval_criterios WHERE activo = 1");
  const mapa = new Map((Array.isArray(respuestas) ? respuestas : []).map(r => [+r.criterio_id, +r.puntaje]));
  for (const c of crit) {
    const p = mapa.get(c.id);
    if (!Number.isInteger(p) || p < 1 || p > 5) throw fail(400, "Contesta todas las preguntas con un valor de 1 a 5.");
  }
  const com = txt(comentario) ? comentario.trim().slice(0, 500) : null;
  const promedio = Math.round((crit.reduce((s, c) => s + mapa.get(c.id), 0) / crit.length) * 100) / 100;   // lo calcula el servidor
  await tx(async c => {
    const [r] = await c.query("INSERT INTO eval_evaluaciones (alumno_id, docente_id, periodo_id, comentario, promedio) VALUES (?,?,?,?,?)",
      [req.u.alumno_id, docente_id, periodo_id, com, promedio]);
    await c.query("INSERT INTO eval_respuestas (evaluacion_id, criterio_id, puntaje) VALUES ?", [crit.map(k => [r.insertId, k.id, mapa.get(k.id)])]);
  });
  await log(req.u.id, `Evaluación docente enviada (docente #${docente_id})`);   // la bitácora no guarda calificaciones
  res.status(201).json({ ok: true, mensaje: "¡Gracias! Tu evaluación se registró de forma anónima." });
}));

// Admin: resultados por docente y periodo (promedio, participación y nivel calculados por la vista)
app.get("/api/evaluaciones/resultados", auth, solo("ADMIN"), ah(async (req, res) => {
  const periodo = req.query.periodo ? String(req.query.periodo) : null;
  res.json(await q(`SELECT * FROM v_eval_docente ${periodo ? "WHERE periodo = ?" : ""} ORDER BY promedio IS NULL, promedio DESC`, periodo ? [periodo] : []));
}));

// Admin: promedio por pregunta de un docente
app.get("/api/evaluaciones/criterios-docente/:docenteId", auth, solo("ADMIN"), ah(async (req, res) =>
  res.json(await q("SELECT categoria, texto, respuestas, promedio FROM v_eval_criterio_docente WHERE docente_id = ? ORDER BY criterio_id", [req.params.docenteId]))));

// Admin: comentarios sin ningún dato del alumno
app.get("/api/evaluaciones/comentarios", auth, solo("ADMIN"), ah(async (req, res) =>
  res.json(await q(`SELECT d.nombre AS docente, p.nombre AS periodo, e.comentario, DATE_FORMAT(e.fecha_hora,'%d/%m/%Y') AS fecha
      FROM eval_evaluaciones e JOIN docentes d ON d.id = e.docente_id JOIN periodos p ON p.id = e.periodo_id
      WHERE e.comentario IS NOT NULL ORDER BY e.id DESC LIMIT 200`))));

// Admin: ventana de evaluación por periodo
app.get("/api/evaluaciones/ventanas", auth, solo("ADMIN"), ah(async (req, res) =>
  res.json(await q(`SELECT p.id AS periodo_id, p.nombre, DATE_FORMAT(v.fecha_apertura,'%Y-%m-%d') AS fecha_apertura,
      DATE_FORMAT(v.fecha_cierre,'%Y-%m-%d') AS fecha_cierre, COALESCE(CURDATE() BETWEEN v.fecha_apertura AND v.fecha_cierre, 0) AS abierta
      FROM periodos p LEFT JOIN eval_ventanas v ON v.periodo_id = p.id ORDER BY p.fecha_inicio`))));
app.put("/api/evaluaciones/ventanas/:periodoId", auth, solo("ADMIN"), ah(async (req, res) => {
  const { fecha_apertura: a, fecha_cierre: c } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a || "") || !/^\d{4}-\d{2}-\d{2}$/.test(c || "")) throw fail(400, "Escribe las fechas de apertura y cierre.");
  if (c < a) throw fail(400, "El cierre no puede ser anterior a la apertura.");
  await q(`INSERT INTO eval_ventanas (periodo_id, fecha_apertura, fecha_cierre) VALUES (?,?,?)
           ON DUPLICATE KEY UPDATE fecha_apertura = VALUES(fecha_apertura), fecha_cierre = VALUES(fecha_cierre)`, [req.params.periodoId, a, c]);
  await log(req.u.id, `Ventana de evaluación docente actualizada (periodo #${req.params.periodoId})`);
  res.json({ ok: true });
}));

// Docente: solo su propio promedio, general y por periodo (sin comentarios ni datos de alumnos)
app.get("/api/evaluaciones/mi-resultado", auth, solo("DOCENTE"), ah(async (req, res) => {
  const grupos = await q(`SELECT periodo, materias, evaluaciones, inscritos, participacion_pct, promedio, nivel
      FROM v_eval_docente WHERE docente_id = ? ORDER BY periodo_id`, [req.u.docente_id]);
  const [t] = await q("SELECT COUNT(*) AS evaluaciones, ROUND(AVG(promedio),2) AS promedio FROM eval_evaluaciones WHERE docente_id = ?", [req.u.docente_id]);
  const nivel = !t.evaluaciones ? "Sin evaluaciones" : t.promedio >= 4.5 ? "Excelente" : t.promedio >= 4 ? "Bueno" : t.promedio >= 3 ? "Regular" : "Requiere atención";
  res.json({ promedio: t.promedio, evaluaciones: t.evaluaciones, nivel, grupos });
}));

/* ---------- EVALUACIÓN DE INSTALACIONES Y SERVICIOS (solo alumnos) ----------
   ALUMNO -> contesta una vez por periodo (4 áreas, 12 preguntas, escala 1 a 5).
   ADMIN  -> ve promedio y nivel por área, detalle por pregunta, participación y comentarios.
   Usa la misma ventana de fechas que la evaluación docente. */
const periodoActual = async () => (await q(`SELECT id, nombre FROM periodos
  ORDER BY (CURDATE() BETWEEN fecha_inicio AND fecha_fin) DESC, fecha_inicio DESC LIMIT 1`))[0];
const nivelDe = p => p == null ? "Sin evaluaciones" : p >= 4.5 ? "Excelente" : p >= 4 ? "Bueno" : p >= 3 ? "Regular" : "Requiere atención";

app.get("/api/instalaciones/criterios", auth, solo("ALUMNO", "ADMIN"), ah(async (req, res) => {
  const filas = await q(`SELECT a.id AS area_id, a.nombre AS area, c.id, c.texto FROM inst_criterios c
      JOIN inst_areas a ON a.id = c.area_id WHERE c.activo = 1 ORDER BY a.orden, c.orden`);
  const areas = [];
  for (const f of filas) {
    let a = areas.find(x => x.id === f.area_id);
    if (!a) areas.push(a = { id: f.area_id, nombre: f.area, criterios: [] });
    a.criterios.push({ id: f.id, texto: f.texto });
  }
  res.json(areas);
}));

app.get("/api/instalaciones/estado", auth, solo("ALUMNO"), ah(async (req, res) => {
  const p = await periodoActual();
  if (!p) return res.json({ periodo: null });
  const [ya] = await q("SELECT 1 AS x FROM inst_evaluaciones WHERE alumno_id = ? AND periodo_id = ?", [req.u.alumno_id, p.id]);
  const v = await ventanaDe(p.id);
  res.json({ periodo_id: p.id, periodo: p.nombre, ventana: v, evaluada: !!ya, puede_evaluar: !ya && !!v?.abierta });
}));

app.post("/api/instalaciones", auth, solo("ALUMNO"), ah(async (req, res) => {
  const p = await periodoActual();
  if (!p || +req.body.periodo_id !== p.id) throw fail(400, "Periodo no válido.");
  const [al] = await q("SELECT 1 AS x FROM alumnos WHERE id = ? AND estatus = 'ACTIVO'", [req.u.alumno_id]);
  if (!al) throw fail(403, "Solo los alumnos activos pueden evaluar las instalaciones.");
  const [ya] = await q("SELECT 1 AS x FROM inst_evaluaciones WHERE alumno_id = ? AND periodo_id = ?", [req.u.alumno_id, p.id]);
  if (ya) throw fail(409, "Ya evaluaste las instalaciones en este periodo.");
  const v = await ventanaDe(p.id);
  if (!v?.abierta) throw fail(409, v ? `La evaluación estuvo disponible del ${v.fecha_apertura} al ${v.fecha_cierre}.` : "La evaluación aún no está habilitada para este periodo.");
  const crit = await q("SELECT id FROM inst_criterios WHERE activo = 1");
  const mapa = new Map((Array.isArray(req.body.respuestas) ? req.body.respuestas : []).map(r => [+r.criterio_id, +r.puntaje]));
  for (const c of crit) { const x = mapa.get(c.id); if (!Number.isInteger(x) || x < 1 || x > 5) throw fail(400, "Contesta todas las preguntas con un valor de 1 a 5."); }
  const com = txt(req.body.comentario) ? req.body.comentario.trim().slice(0, 500) : null;
  const promedio = Math.round((crit.reduce((t, c) => t + mapa.get(c.id), 0) / crit.length) * 100) / 100;
  await tx(async c => {
    const [r] = await c.query("INSERT INTO inst_evaluaciones (alumno_id, periodo_id, comentario, promedio) VALUES (?,?,?,?)", [req.u.alumno_id, p.id, com, promedio]);
    await c.query("INSERT INTO inst_respuestas (evaluacion_id, criterio_id, puntaje) VALUES ?", [crit.map(k => [r.insertId, k.id, mapa.get(k.id)])]);
  });
  await log(req.u.id, "Evaluación de instalaciones enviada");
  res.status(201).json({ ok: true, mensaje: "¡Gracias! Tu opinión sobre las instalaciones se registró de forma anónima." });
}));

app.get("/api/instalaciones/resultados", auth, solo("ADMIN"), ah(async (req, res) => {
  const p = req.query.periodoId ? (await q("SELECT id, nombre FROM periodos WHERE id = ?", [req.query.periodoId]))[0] : await periodoActual();
  if (!p) return res.json({ periodo: null, areas: [], criterios: [], comentarios: [] });
  const [t] = await q("SELECT COUNT(*) AS evaluaciones, ROUND(AVG(promedio),2) AS promedio FROM inst_evaluaciones WHERE periodo_id = ?", [p.id]);
  const [a] = await q("SELECT COUNT(*) AS n FROM alumnos WHERE estatus = 'ACTIVO'");
  const areasBase = await q("SELECT id, nombre FROM inst_areas ORDER BY orden");
  const vista = await q("SELECT area_id, evaluaciones, promedio, nivel FROM v_inst_area WHERE periodo_id = ?", [p.id]);
  res.json({
    periodo_id: p.id, periodo: p.nombre, evaluaciones: t.evaluaciones, alumnos_activos: a.n,
    participacion_pct: a.n ? Math.round(1000 * t.evaluaciones / a.n) / 10 : 0,
    promedio: t.promedio, nivel: nivelDe(t.promedio), ventana: await ventanaDe(p.id),
    areas: areasBase.map(x => { const v = vista.find(y => y.area_id === x.id); return { area: x.nombre, promedio: v?.promedio ?? null, nivel: v?.nivel || "Sin evaluaciones" }; }),
    criterios: await q("SELECT area, texto, respuestas, promedio FROM v_inst_criterio WHERE periodo_id = ? ORDER BY orden", [p.id]),
    comentarios: await q(`SELECT comentario, DATE_FORMAT(fecha_hora,'%d/%m/%Y') AS fecha FROM inst_evaluaciones
      WHERE periodo_id = ? AND comentario IS NOT NULL ORDER BY id DESC LIMIT 200`, [p.id])
  });
}));

/* ---------- errores ---------- */
app.use("/api", (req, res) => res.status(404).json({ error: "Ruta no encontrada" }));
app.use((err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  if (err.errno === 1644) return res.status(409).json({ error: err.sqlMessage });
  const m = { ER_DUP_ENTRY: [409, "Ya existe un registro con ese valor único."], ER_ROW_IS_REFERENCED_2: [409, "No se puede eliminar: tiene registros relacionados."],
    ER_NO_REFERENCED_ROW_2: [400, "Referencia inexistente."], ER_CHECK_CONSTRAINT_VIOLATED: [400, "Valor fuera de rango."] }[err.code];
  if (m) return res.status(m[0]).json({ error: m[1] });
  console.error(err); res.status(500).json({ error: "Error interno del servidor" });
});

pool.query("SELECT 1").then(() => console.log("MySQL conectado: " + (process.env.DB_NAME || "sia_demo")))
  .catch(e => console.error("NO se pudo conectar a MySQL:", e.message));
app.listen(process.env.PORT || 3000, "0.0.0.0", () => {
  console.log(`SIA en http://localhost:${process.env.PORT || 3000}`);
  console.log(`Desde tu celular (misma red Wi-Fi): ${APP_URL}`);
});