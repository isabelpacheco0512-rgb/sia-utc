-- =====================================================================
-- SIA · Sistema de Información Académico · Universidad Tecnológica del Centro
-- Modelo relacional v0.1 (MySQL 8.0.16 o superior, por los CHECK)
-- =====================================================================
DROP DATABASE IF EXISTS sia_demo;
CREATE DATABASE sia_demo CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE sia_demo;

-- ---------------------------------------------------------------------
-- 1. TABLAS
-- ---------------------------------------------------------------------
CREATE TABLE programas (
  id     INT PRIMARY KEY AUTO_INCREMENT,
  clave  VARCHAR(15)  NOT NULL UNIQUE,
  nombre VARCHAR(100) NOT NULL
);

CREATE TABLE alumnos (
  id          INT PRIMARY KEY AUTO_INCREMENT,
  matricula   VARCHAR(20)  NOT NULL UNIQUE,
  nombres     VARCHAR(80)  NOT NULL,
  apellidos   VARCHAR(100) NOT NULL,
  correo      VARCHAR(120) NOT NULL UNIQUE,
  programa_id INT NOT NULL,
  estatus     ENUM('ACTIVO','INACTIVO') NOT NULL DEFAULT 'ACTIVO',   -- baja lógica
  FOREIGN KEY (programa_id) REFERENCES programas(id),
  INDEX idx_alumnos_programa (programa_id),
  INDEX idx_alumnos_nombre (apellidos, nombres)
);

CREATE TABLE docentes (
  id              INT PRIMARY KEY AUTO_INCREMENT,
  numero_empleado VARCHAR(20)  NOT NULL UNIQUE,
  nombre          VARCHAR(120) NOT NULL,
  correo          VARCHAR(120) NOT NULL UNIQUE
);

CREATE TABLE materias (
  id          INT PRIMARY KEY AUTO_INCREMENT,
  clave       VARCHAR(20)  NOT NULL UNIQUE,
  nombre      VARCHAR(100) NOT NULL,
  creditos    INT NOT NULL CHECK (creditos > 0),
  programa_id INT NOT NULL,
  FOREIGN KEY (programa_id) REFERENCES programas(id),
  INDEX idx_materias_programa (programa_id)
);

CREATE TABLE periodos (
  id           INT PRIMARY KEY AUTO_INCREMENT,
  nombre       VARCHAR(40) NOT NULL UNIQUE,
  fecha_inicio DATE NOT NULL,
  fecha_fin    DATE NOT NULL,
  CHECK (fecha_fin >= fecha_inicio)
);

CREATE TABLE grupos (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  clave      VARCHAR(20) NOT NULL UNIQUE,
  materia_id INT NOT NULL,
  docente_id INT NOT NULL,
  periodo_id INT NOT NULL,
  cupo       INT NOT NULL,
  CHECK (cupo > 0),
  FOREIGN KEY (materia_id) REFERENCES materias(id),
  FOREIGN KEY (docente_id) REFERENCES docentes(id),
  FOREIGN KEY (periodo_id) REFERENCES periodos(id),
  INDEX idx_grupos_periodo (periodo_id),
  INDEX idx_grupos_docente (docente_id)
);

CREATE TABLE horarios (
  id          INT PRIMARY KEY AUTO_INCREMENT,
  grupo_id    INT NOT NULL,
  dia_semana  ENUM('LUN','MAR','MIE','JUE','VIE','SAB') NOT NULL,
  hora_inicio TIME NOT NULL,
  hora_fin    TIME NOT NULL,
  aula        VARCHAR(30) NOT NULL,
  CHECK (hora_fin > hora_inicio),
  FOREIGN KEY (grupo_id) REFERENCES grupos(id) ON DELETE CASCADE,
  INDEX idx_horarios_grupo (grupo_id, dia_semana)
);

CREATE TABLE inscripciones (
  id        INT PRIMARY KEY AUTO_INCREMENT,
  alumno_id INT NOT NULL,
  grupo_id  INT NOT NULL,
  fecha     DATE NOT NULL,
  estatus   ENUM('INSCRITO','BAJA') NOT NULL DEFAULT 'INSCRITO',
  UNIQUE (alumno_id, grupo_id),                    -- sin doble inscripción
  FOREIGN KEY (alumno_id) REFERENCES alumnos(id),
  FOREIGN KEY (grupo_id)  REFERENCES grupos(id),
  INDEX idx_inscripciones_grupo (grupo_id, estatus)
);

CREATE TABLE calificaciones (
  id             INT PRIMARY KEY AUTO_INCREMENT,
  inscripcion_id INT NOT NULL UNIQUE,              -- relación 1 a 0..1
  parcial1       DECIMAL(5,2) NULL,
  parcial2       DECIMAL(5,2) NULL,
  final          DECIMAL(5,2) NULL,
  CHECK (parcial1 BETWEEN 0 AND 100),
  CHECK (parcial2 BETWEEN 0 AND 100),
  CHECK (final    BETWEEN 0 AND 100),
  FOREIGN KEY (inscripcion_id) REFERENCES inscripciones(id)
);

CREATE TABLE usuarios (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  email         VARCHAR(120) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  rol           ENUM('ADMIN','DOCENTE','ALUMNO') NOT NULL,
  alumno_id     INT NULL,
  docente_id    INT NULL,
  activo        BOOLEAN NOT NULL DEFAULT TRUE,
  FOREIGN KEY (alumno_id)  REFERENCES alumnos(id),
  FOREIGN KEY (docente_id) REFERENCES docentes(id),
  CHECK (alumno_id IS NULL OR docente_id IS NULL)  -- una cuenta no es alumno y docente a la vez
);

-- Bitácora (diseño de seguridad E06)
CREATE TABLE bitacora (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  fecha      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  usuario_id INT NULL,
  accion     VARCHAR(200) NOT NULL,
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id),
  INDEX idx_bitacora_fecha (fecha)
);

-- ---------------------------------------------------------------------
-- 2. INSCRIPCIÓN TRANSACCIONAL (valida cupo, doble inscripción y choque)
-- ---------------------------------------------------------------------
DELIMITER //
CREATE PROCEDURE sp_inscribir(IN p_alumno INT, IN p_grupo INT)
BEGIN
  DECLARE v_cupo INT;
  DECLARE v_periodo INT;
  DECLARE v_ocupados INT;
  DECLARE v_choque INT;
  DECLARE v_activo INT;
  DECLARE v_ya INT;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;

  START TRANSACTION;
  SELECT cupo, periodo_id INTO v_cupo, v_periodo FROM grupos WHERE id = p_grupo FOR UPDATE;
  IF v_cupo IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Grupo inexistente'; END IF;

  SELECT COUNT(*) INTO v_activo FROM alumnos WHERE id = p_alumno AND estatus = 'ACTIVO';
  IF v_activo = 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Alumno inexistente o inactivo'; END IF;

  SELECT COUNT(*) INTO v_ya FROM inscripciones
   WHERE alumno_id = p_alumno AND grupo_id = p_grupo AND estatus = 'INSCRITO';
  IF v_ya > 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'El alumno ya está inscrito en el grupo'; END IF;

  SELECT COUNT(*) INTO v_ocupados FROM inscripciones WHERE grupo_id = p_grupo AND estatus = 'INSCRITO';
  IF v_ocupados >= v_cupo THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Grupo sin cupo'; END IF;

  SELECT COUNT(*) INTO v_choque
    FROM inscripciones i
    JOIN grupos g    ON g.id = i.grupo_id AND g.periodo_id = v_periodo
    JOIN horarios h1 ON h1.grupo_id = i.grupo_id
    JOIN horarios h2 ON h2.grupo_id = p_grupo
                    AND h1.dia_semana = h2.dia_semana
                    AND h1.hora_inicio < h2.hora_fin
                    AND h2.hora_inicio < h1.hora_fin
   WHERE i.alumno_id = p_alumno AND i.estatus = 'INSCRITO';
  IF v_choque > 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Choque de horario'; END IF;

  INSERT INTO inscripciones (alumno_id, grupo_id, fecha, estatus)
  VALUES (p_alumno, p_grupo, CURDATE(), 'INSCRITO')
  ON DUPLICATE KEY UPDATE estatus = 'INSCRITO', fecha = CURDATE();
  COMMIT;
END//
DELIMITER ;

-- ---------------------------------------------------------------------
-- 3. VISTAS (pantallas Horarios y Reportes)
-- ---------------------------------------------------------------------
CREATE VIEW v_horarios AS
SELECT g.id AS grupo_id, g.clave AS grupo, m.nombre AS materia, d.nombre AS docente,
       h.dia_semana, h.hora_inicio, h.hora_fin, h.aula, g.periodo_id
  FROM horarios h
  JOIN grupos g    ON g.id = h.grupo_id
  JOIN materias m  ON m.id = g.materia_id
  JOIN docentes d  ON d.id = g.docente_id;

CREATE VIEW v_reporte_periodo_programa AS
SELECT pe.id AS periodo_id, pe.nombre AS periodo, p.id AS programa_id, p.nombre AS programa,
       COUNT(i.id) AS inscritos,
       ROUND(AVG(COALESCE(c.final, (COALESCE(c.parcial1, c.parcial2) + COALESCE(c.parcial2, c.parcial1)) / 2)), 1) AS promedio
  FROM periodos pe
  CROSS JOIN programas p
  LEFT JOIN grupos g          ON g.periodo_id = pe.id
  LEFT JOIN inscripciones i   ON i.grupo_id = g.id AND i.estatus = 'INSCRITO'
                              AND i.alumno_id IN (SELECT a.id FROM alumnos a WHERE a.programa_id = p.id)
  LEFT JOIN calificaciones c  ON c.inscripcion_id = i.id
 GROUP BY pe.id, pe.nombre, p.id, p.nombre;

-- ---------------------------------------------------------------------
-- 4. DATOS DE PRUEBA (los mismos que usa prototipo_sia.html)
-- ---------------------------------------------------------------------
INSERT INTO programas (clave, nombre) VALUES
 ('ISC','Ingeniería en Sistemas Computacionales'),('ADM','Administración'),
 ('CON','Contaduría'),('MEC','Mecatrónica');

INSERT INTO alumnos (matricula, nombres, apellidos, correo, programa_id, estatus) VALUES
 ('UTC2026001','Daniela','López García','daniela.lopez@demo.edu',1,'ACTIVO'),
 ('UTC2026002','Luis','Martínez Ruiz','luis.martinez@demo.edu',1,'ACTIVO'),
 ('UTC2026003','Sofía','Hernández Vega','sofia.hernandez@demo.edu',1,'ACTIVO'),
 ('UTC2026004','Iván','Torres Luna','ivan.torres@demo.edu',4,'INACTIVO'),
 ('UTC2026005','Karla','Núñez Ibarra','karla.nunez@demo.edu',3,'ACTIVO'),
 ('UTC2026006','Diego','Ramírez Soto','diego.ramirez@demo.edu',2,'ACTIVO');

INSERT INTO docentes (numero_empleado, nombre, correo) VALUES
 ('DOC-101','María Torres','maria.torres@demo.edu'),('DOC-102','Elena Ruiz','elena.ruiz@demo.edu'),
 ('DOC-103','Luis Pineda','luis.pineda@demo.edu'),('DOC-104','Rosa Aguirre','rosa.aguirre@demo.edu'),
 ('DOC-105','Ana Duarte','ana.duarte@demo.edu');

INSERT INTO materias (clave, nombre, creditos, programa_id) VALUES
 ('BD7','Bases de Datos Avanzadas',6,1),('PW7','Programación Web',6,1),
 ('RC7','Redes de Computadoras',5,1),('IS7','Ingeniería de Software',6,1),('IT7','Inglés técnico',3,1);

INSERT INTO periodos (nombre, fecha_inicio, fecha_fin) VALUES ('Otoño 2026','2026-09-07','2026-12-18');

INSERT INTO grupos (clave, materia_id, docente_id, periodo_id, cupo) VALUES
 ('BD701',1,1,1,30),('PW701',2,2,1,30),('RC701',3,3,1,25),('IS701',4,4,1,30),('IT701',5,5,1,30);

INSERT INTO horarios (grupo_id, dia_semana, hora_inicio, hora_fin, aula) VALUES
 (1,'LUN','09:00','11:00','A-204'),(1,'MIE','09:00','11:00','A-204'),
 (2,'LUN','09:00','11:00','B-101'),(2,'MIE','09:00','11:00','B-101'),
 (3,'MAR','09:00','11:00','L-1'),(3,'JUE','09:00','11:00','L-1'),
 (4,'MAR','11:00','13:00','B-102'),(4,'JUE','11:00','13:00','B-102'),
 (5,'VIE','10:00','13:00','C-301');

INSERT INTO inscripciones (alumno_id, grupo_id, fecha) VALUES (1,1,'2026-10-01'),(2,1,'2026-10-01');
INSERT INTO calificaciones (inscripcion_id, parcial1, parcial2, final) VALUES (1,90,92,NULL),(2,85,88,NULL);

-- Hash SHA-256 solo para la demostración. En la API real se usará bcrypt o argon2.
INSERT INTO usuarios (email, password_hash, rol, alumno_id, docente_id) VALUES
 ('admin@demo.edu',          SHA2('admin123',256),   'ADMIN',   NULL, NULL),
 ('maria.torres@demo.edu',   SHA2('docente123',256), 'DOCENTE', NULL, 1),
 ('daniela.lopez@demo.edu',  SHA2('alumno123',256),  'ALUMNO',  1,    NULL);

-- ---------------------------------------------------------------------
-- 5. CONSULTAS Y CASOS DE PRUEBA DEL DOCUMENTO (sección 11)
-- ---------------------------------------------------------------------
-- Inscripciones con alumno, grupo y materia
SELECT a.matricula, CONCAT(a.nombres,' ',a.apellidos) AS alumno, g.clave AS grupo, m.nombre AS materia, i.estatus
  FROM inscripciones i JOIN alumnos a ON a.id=i.alumno_id JOIN grupos g ON g.id=i.grupo_id JOIN materias m ON m.id=g.materia_id;

-- CP-05: horario de BD701 -> LUN/MIE 09:00-11:00, A-204
SELECT * FROM v_horarios WHERE grupo = 'BD701';

-- CP-06: reporte Otoño 2026 -> 2 inscripciones activas (ISC)
SELECT * FROM v_reporte_periodo_programa WHERE periodo = 'Otoño 2026';

-- CP-01: matrícula repetida (debe fallar por UNIQUE)
-- INSERT INTO alumnos (matricula,nombres,apellidos,correo,programa_id) VALUES ('UTC2026001','X','Y','x@demo.edu',1);
-- CP-02: doble inscripción (debe fallar)
-- CALL sp_inscribir(1,1);
-- CP-03: nota 105 (debe fallar por CHECK)
-- UPDATE calificaciones SET parcial1 = 105 WHERE id = 1;
-- Choque de horario: Sofía en BD701 y luego en PW701 (el segundo CALL falla)
-- CALL sp_inscribir(3,1); CALL sp_inscribir(3,2);
