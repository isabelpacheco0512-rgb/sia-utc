# SIA API

API REST (Node.js, Express y MySQL 8) del Sistema de Información Académico. También sirve la interfaz desde `public/`.

## Puesta en marcha
1. **Base de datos:** ejecuta `db/sia_base_datos.sql` en MySQL 8.0.16 o superior (por ejemplo con la extensión MySQL de VS Code, o `mysql -u root -p < db/sia_base_datos.sql`).
2. **Dependencias:** `npm install`
3. **Configuración:** copia `.env.example` como `.env` y ajusta usuario y contraseña de MySQL y `JWT_SECRET`.
4. **Contraseñas de demostración con bcrypt:** `npm run seed`
5. **Servidor:** `npm start` y abre http://localhost:3000

Cuentas de demostración: `admin@demo.edu` / `admin123`, `maria.torres@demo.edu` / `docente123`, `daniela.lopez@demo.edu` / `alumno123`.

## Rutas
Todas, salvo el login, requieren `Authorization: Bearer <token>` y validan el rol.

| Método y ruta | Rol | Requerimiento |
|---|---|---|
| POST /api/login | Todos | RF-06 |
| GET /api/datos | Todos (filtrado por rol) | Carga de la interfaz |
| GET, POST /api/alumnos · PUT, DELETE /api/alumnos/:id | Admin | RF-01 (DELETE es baja lógica) |
| GET, POST /api/inscripciones · PUT /api/inscripciones/:id/baja | Admin | RF-02 |
| GET, POST /api/grupos · PUT /api/grupos/:id | Todos lectura · Admin escritura | RF-08 |
| GET, PUT /api/calificaciones/:inscripcionId | Admin, Docente (solo su grupo) y Alumno (solo lo suyo) leen · Docente escribe | RF-03 |
| GET /api/horarios?grupoId=&alumnoId= | Todos | RF-04 |
| GET /api/reportes?periodoId=&programaId= | Admin | RF-05 |
| GET, POST, PUT, DELETE /api/catalogos/:tabla | Lectura todos · Admin escritura | RF-09 |
| GET /api/bitacora | Admin | RF-10 |

Reglas en la base de datos: cupo, doble inscripción y choque de horario los valida `sp_inscribir`; notas, unicidad y llaves foráneas las garantizan las restricciones de las tablas. Todas las consultas son parametrizadas.
