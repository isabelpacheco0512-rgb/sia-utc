-- =====================================================================
-- SIA · Módulo EVALUACIÓN DOCENTE (función principal)
-- Ejecutar sobre la base sia_demo YA existente. Se puede correr varias veces.
-- =====================================================================
USE sia_demo;

DROP VIEW  IF EXISTS v_eval_criterio_docente;
DROP VIEW  IF EXISTS v_eval_docente;
DROP TABLE IF EXISTS eval_respuestas;
DROP TABLE IF EXISTS eval_evaluaciones;
DROP TABLE IF EXISTS eval_ventanas;
DROP TABLE IF EXISTS eval_criterios;

-- 1. Criterios del cuestionario (se pueden agregar/desactivar sin tocar código)
CREATE TABLE eval_criterios (
  id        INT PRIMARY KEY AUTO_INCREMENT,
  categoria ENUM('DOMINIO','DIDACTICA','COMUNICACION','PUNTUALIDAD','EVALUACION') NOT NULL,
  texto     VARCHAR(200) NOT NULL,
  orden     INT NOT NULL,
  activo    TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE (orden)
);

-- 2. Ventana de evaluación por periodo (abre y cierra sola según la fecha)
CREATE TABLE eval_ventanas (
  periodo_id     INT PRIMARY KEY,
  fecha_apertura DATE NOT NULL,
  fecha_cierre   DATE NOT NULL,
  CHECK (fecha_cierre >= fecha_apertura),
  FOREIGN KEY (periodo_id) REFERENCES periodos(id)
);

-- 3. Una evaluación por alumno, docente y periodo: si el docente da varias materias,
--    el alumno lo evalúa UNA sola vez (la UNIQUE lo garantiza aunque falle la API)
CREATE TABLE eval_evaluaciones (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  alumno_id  INT NOT NULL,
  docente_id INT NOT NULL,
  periodo_id INT NOT NULL,
  comentario VARCHAR(500) NULL,
  promedio   DECIMAL(3,2) NULL,                 -- lo calcula el servidor
  fecha_hora DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (alumno_id, docente_id, periodo_id),
  FOREIGN KEY (alumno_id)  REFERENCES alumnos(id),
  FOREIGN KEY (docente_id) REFERENCES docentes(id),
  FOREIGN KEY (periodo_id) REFERENCES periodos(id),
  INDEX idx_eval_docente (docente_id, periodo_id)
);

-- 4. Respuesta de 1 a 5 por cada criterio
CREATE TABLE eval_respuestas (
  evaluacion_id INT NOT NULL,
  criterio_id   INT NOT NULL,
  puntaje       TINYINT NOT NULL,
  PRIMARY KEY (evaluacion_id, criterio_id),
  CHECK (puntaje BETWEEN 1 AND 5),
  FOREIGN KEY (evaluacion_id) REFERENCES eval_evaluaciones(id) ON DELETE CASCADE,
  FOREIGN KEY (criterio_id)   REFERENCES eval_criterios(id)
);

-- 5. Vista: resultado automático por docente y periodo (todas sus materias juntas)
CREATE VIEW v_eval_docente AS
SELECT x.*,
       ROUND(100 * x.evaluaciones / NULLIF(x.inscritos, 0), 1) AS participacion_pct,
       CASE WHEN x.evaluaciones = 0 THEN 'Sin evaluaciones'
            WHEN x.promedio >= 4.5 THEN 'Excelente'
            WHEN x.promedio >= 4.0 THEN 'Bueno'
            WHEN x.promedio >= 3.0 THEN 'Regular'
            ELSE 'Requiere atención' END AS nivel
  FROM (
    SELECT pe.id AS periodo_id, pe.nombre AS periodo, d.id AS docente_id, d.nombre AS docente,
           (SELECT GROUP_CONCAT(DISTINCT m.nombre ORDER BY m.nombre SEPARATOR ', ')
              FROM grupos g2 JOIN materias m ON m.id = g2.materia_id
             WHERE g2.docente_id = d.id AND g2.periodo_id = pe.id) AS materias,
           (SELECT COUNT(DISTINCT i.alumno_id)
              FROM inscripciones i JOIN grupos g3 ON g3.id = i.grupo_id
             WHERE g3.docente_id = d.id AND g3.periodo_id = pe.id AND i.estatus = 'INSCRITO') AS inscritos,
           COUNT(e.id) AS evaluaciones,
           ROUND(AVG(e.promedio), 2) AS promedio
      FROM (SELECT DISTINCT docente_id, periodo_id FROM grupos) gp
      JOIN docentes d ON d.id = gp.docente_id
      JOIN periodos pe ON pe.id = gp.periodo_id
      LEFT JOIN eval_evaluaciones e ON e.docente_id = d.id AND e.periodo_id = pe.id
     GROUP BY pe.id, pe.nombre, d.id, d.nombre
  ) x;

-- 6. Vista: promedio por criterio y docente (para ver en qué falla o destaca)
CREATE VIEW v_eval_criterio_docente AS
SELECT e.docente_id, c.id AS criterio_id, c.categoria, c.texto,
       COUNT(*) AS respuestas, ROUND(AVG(r.puntaje), 2) AS promedio
  FROM eval_respuestas r
  JOIN eval_evaluaciones e ON e.id = r.evaluacion_id
  JOIN eval_criterios c ON c.id = r.criterio_id
 GROUP BY e.docente_id, c.id, c.categoria, c.texto;

-- 7. Datos iniciales
INSERT INTO eval_criterios (categoria, texto, orden) VALUES
 ('DOMINIO','Demuestra dominio de los temas de la materia',1),
 ('DOMINIO','Relaciona la teoría con ejemplos prácticos',2),
 ('DIDACTICA','Explica de forma clara y ordenada',3),
 ('DIDACTICA','Usa recursos y actividades que ayudan a aprender',4),
 ('COMUNICACION','Trata a los estudiantes con respeto',5),
 ('COMUNICACION','Resuelve dudas dentro y fuera de clase',6),
 ('PUNTUALIDAD','Inicia y termina la clase a la hora indicada',7),
 ('PUNTUALIDAD','Asiste con regularidad a sus sesiones',8),
 ('EVALUACION','Los criterios de evaluación se explicaron desde el inicio',9),
 ('EVALUACION','Entrega las calificaciones y la retroalimentación a tiempo',10);

INSERT INTO eval_ventanas (periodo_id, fecha_apertura, fecha_cierre)
SELECT id, '2026-11-02', '2026-12-04' FROM periodos WHERE nombre = 'Otoño 2026';

-- Evaluación de ejemplo: el alumno 2 evalúa a la docente 1 (la alumna 1 queda pendiente para la demostración)
INSERT INTO eval_evaluaciones (alumno_id, docente_id, periodo_id, comentario, promedio)
VALUES (2, 1, 1, 'Explica muy claro y resuelve dudas.', NULL);

INSERT INTO eval_respuestas (evaluacion_id, criterio_id, puntaje)
SELECT 1, id, CASE WHEN id % 3 = 0 THEN 4 ELSE 5 END FROM eval_criterios;

UPDATE eval_evaluaciones
   SET promedio = (SELECT ROUND(AVG(puntaje),2) FROM eval_respuestas WHERE evaluacion_id = 1)
 WHERE id = 1;

-- Comprobación
SELECT * FROM v_eval_docente;