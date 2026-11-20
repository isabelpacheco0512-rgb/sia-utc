// Reemplaza los hashes SHA2 de demostración por hashes bcrypt reales.
import "dotenv/config";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";

const c = await mysql.createConnection({
  host: process.env.DB_HOST || "localhost", port: +(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root", password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "sia_demo"
});
const cuentas = [["admin@demo.edu", "admin123"], ["maria.torres@demo.edu", "docente123"], ["daniela.lopez@demo.edu", "alumno123"]];
for (const [email, clave] of cuentas)
  await c.query("UPDATE usuarios SET password_hash = ? WHERE email = ?", [await bcrypt.hash(clave, 10), email]);
console.log("Contraseñas de demostración actualizadas con bcrypt.");
await c.end();
