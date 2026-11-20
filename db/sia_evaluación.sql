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

-- 3. Una evaluación por inscripción (alumno + grupo): no se puede evaluar dos veces
CREATE TABLE eval_evaluaciones (
  id             INT PRIMARY KEY AUTO_INCREMENT,
  inscripcion_id INT NOT NULL UNIQUE,
  grupo_id       INT NOT NULL,
  docente_id     INT NOT NULL,
  comentario     VARCHAR(500) NULL,
  promedio       DECIMAL(3,2) NULL,              -- lo calcula el servidor
  fecha_hora     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (inscripcion_id) REFERENCES inscripciones(id),
  FOREIGN KEY (grupo_id)       REFERENCES grupos(id),
  FOREIGN KEY (docente_id)     REFERENCES docentes(id),
  INDEX idx_eval_docente (docente_id),
  INDEX idx_eval_grupo (grupo_id)
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

-- 5. Vista: resultado automático por docente y grupo (promedio, participación, nivel)
CREATE VIEW v_eval_docente AS
SELECT pe.nombre AS periodo,
       d.id AS docente_id, d.nombre AS docente,
       g.id AS grupo_id, g.clave AS grupo, m.nombre AS materia,
       (SELECT COUNT(*) FROM inscripciones i WHERE i.grupo_id = g.id AND i.estatus='INSCRITO') AS inscritos,
       COUNT(e.id) AS evaluaciones,
       ROUND(100 * COUNT(e.id) /
             NULLIF((SELECT COUNT(*) FROM inscripciones i WHERE i.grupo_id = g.id AND i.estatus='INSCRITO'),0), 1) AS participacion_pct,
       ROUND(AVG(e.promedio), 2) AS promedio,
       CASE WHEN COUNT(e.id) = 0 THEN 'Sin evaluaciones'
            WHEN AVG(e.promedio) >= 4.5 THEN 'Excelente'
            WHEN AVG(e.promedio) >= 4.0 THEN 'Bueno'
            WHEN AVG(e.promedio) >= 3.0 THEN 'Regular'
            ELSE 'Requiere atención' END AS nivel
  FROM grupos g
  JOIN docentes d ON d.id = g.docente_id
  JOIN materias m ON m.id = g.materia_id
  JOIN periodos pe ON pe.id = g.periodo_id
  LEFT JOIN eval_evaluaciones e ON e.grupo_id = g.id
 GROUP BY pe.nombre, d.id, d.nombre, g.id, g.clave, m.nombre;

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

-- Evaluación de ejemplo: solo la inscripción 2 (la 1 queda pendiente para la demostración)
INSERT INTO eval_evaluaciones (inscripcion_id, grupo_id, docente_id, comentario, promedio)
SELECT i.id, i.grupo_id, g.docente_id, 'Explica muy claro y resuelve dudas.', NULL
  FROM inscripciones i JOIN grupos g ON g.id = i.grupo_id WHERE i.id = 2;

INSERT INTO eval_respuestas (evaluacion_id, criterio_id, puntaje)
SELECT 1, id, CASE WHEN id % 3 = 0 THEN 4 ELSE 5 END FROM eval_criterios;

UPDATE eval_evaluaciones
   SET promedio = (SELECT ROUND(AVG(puntaje),2) FROM eval_respuestas WHERE evaluacion_id = 1)
 WHERE id = 1;

-- Comprobación
SELECT * FROM v_eval_docente WHERE grupo = 'BD701';