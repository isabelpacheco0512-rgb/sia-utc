-- =====================================================================
-- SIA · Módulo EVALUACIÓN DE INSTALACIONES Y SERVICIOS (solo alumnos)
-- Ejecutar sobre sia_demo YA existente (después de sia_railway.sql).
-- Se puede correr varias veces: borra y vuelve a crear solo este módulo.
-- Usa la MISMA ventana de fechas que la evaluación docente (eval_ventanas).
-- =====================================================================
USE sia_demo;

DROP VIEW  IF EXISTS v_inst_criterio;
DROP VIEW  IF EXISTS v_inst_area;
DROP TABLE IF EXISTS inst_respuestas;
DROP TABLE IF EXISTS inst_evaluaciones;
DROP TABLE IF EXISTS inst_criterios;
DROP TABLE IF EXISTS inst_areas;

-- 1. Áreas que se evalúan
CREATE TABLE inst_areas (
  id     INT PRIMARY KEY AUTO_INCREMENT,
  nombre VARCHAR(80) NOT NULL UNIQUE,
  orden  INT NOT NULL UNIQUE
);

-- 2. Preguntas por área (se pueden agregar o desactivar sin tocar código)
CREATE TABLE inst_criterios (
  id      INT PRIMARY KEY AUTO_INCREMENT,
  area_id INT NOT NULL,
  texto   VARCHAR(200) NOT NULL,
  orden   INT NOT NULL UNIQUE,
  activo  TINYINT(1) NOT NULL DEFAULT 1,
  FOREIGN KEY (area_id) REFERENCES inst_areas(id)
);

-- 3. Una sola evaluación por alumno y periodo
CREATE TABLE inst_evaluaciones (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  alumno_id  INT NOT NULL,
  periodo_id INT NOT NULL,
  comentario VARCHAR(500) NULL,
  promedio   DECIMAL(3,2) NULL,                 -- lo calcula el servidor
  fecha_hora DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (alumno_id, periodo_id),
  FOREIGN KEY (alumno_id)  REFERENCES alumnos(id),
  FOREIGN KEY (periodo_id) REFERENCES periodos(id)
);

-- 4. Respuesta de 1 a 5 por pregunta
CREATE TABLE inst_respuestas (
  evaluacion_id INT NOT NULL,
  criterio_id   INT NOT NULL,
  puntaje       TINYINT NOT NULL,
  PRIMARY KEY (evaluacion_id, criterio_id),
  CHECK (puntaje BETWEEN 1 AND 5),
  FOREIGN KEY (evaluacion_id) REFERENCES inst_evaluaciones(id) ON DELETE CASCADE,
  FOREIGN KEY (criterio_id)   REFERENCES inst_criterios(id)
);

-- 5. Resultado automático por área y periodo
CREATE VIEW v_inst_area AS
SELECT e.periodo_id, p.nombre AS periodo, a.id AS area_id, a.nombre AS area, a.orden,
       COUNT(DISTINCT e.id) AS evaluaciones, COUNT(*) AS respuestas,
       ROUND(AVG(r.puntaje), 2) AS promedio,
       CASE WHEN AVG(r.puntaje) >= 4.5 THEN 'Excelente'
            WHEN AVG(r.puntaje) >= 4.0 THEN 'Bueno'
            WHEN AVG(r.puntaje) >= 3.0 THEN 'Regular'
            ELSE 'Requiere atención' END AS nivel
  FROM inst_respuestas r
  JOIN inst_evaluaciones e ON e.id = r.evaluacion_id
  JOIN inst_criterios c    ON c.id = r.criterio_id
  JOIN inst_areas a        ON a.id = c.area_id
  JOIN periodos p          ON p.id = e.periodo_id
 GROUP BY e.periodo_id, p.nombre, a.id, a.nombre, a.orden;

-- 6. Promedio por pregunta (para ver qué mejorar en cada área)
CREATE VIEW v_inst_criterio AS
SELECT e.periodo_id, a.nombre AS area, c.id AS criterio_id, c.orden, c.texto,
       COUNT(*) AS respuestas, ROUND(AVG(r.puntaje), 2) AS promedio
  FROM inst_respuestas r
  JOIN inst_evaluaciones e ON e.id = r.evaluacion_id
  JOIN inst_criterios c    ON c.id = r.criterio_id
  JOIN inst_areas a        ON a.id = c.area_id
 GROUP BY e.periodo_id, a.nombre, c.id, c.orden, c.texto;

-- 7. Datos iniciales
INSERT INTO inst_areas (nombre, orden) VALUES
 ('Aulas y laboratorios', 1),
 ('Biblioteca e internet', 2),
 ('Baños, cafetería y áreas comunes', 3),
 ('Servicios escolares', 4);

INSERT INTO inst_criterios (area_id, texto, orden) VALUES
 (1, 'Las aulas están limpias, iluminadas y ventiladas', 1),
 (1, 'El mobiliario (bancas, pizarrones) está en buen estado', 2),
 (1, 'Los equipos de cómputo y proyectores funcionan correctamente', 3),
 (2, 'La biblioteca tiene los libros y recursos que necesito', 4),
 (2, 'Hay espacios adecuados para estudiar', 5),
 (2, 'La conexión a internet (Wi-Fi) es estable y rápida', 6),
 (3, 'Los baños están limpios y tienen insumos', 7),
 (3, 'La cafetería ofrece buena calidad a precios accesibles', 8),
 (3, 'Las áreas comunes y verdes son limpias y seguras', 9),
 (4, 'El personal de servicios escolares me atiende con amabilidad', 10),
 (4, 'Los trámites se resuelven en un tiempo razonable', 11),
 (4, 'La información sobre trámites y fechas es clara y oportuna', 12);

-- Evaluación de ejemplo: Luis (alumno 2) en Otoño 2026
INSERT INTO inst_evaluaciones (alumno_id, periodo_id, comentario, promedio)
SELECT 2, id, 'El Wi-Fi se cae seguido en la biblioteca.', NULL FROM periodos WHERE nombre = 'Otoño 2026';
INSERT INTO inst_respuestas (evaluacion_id, criterio_id, puntaje)
SELECT 1, id, CASE WHEN orden IN (6, 8) THEN 3 WHEN orden % 2 = 0 THEN 4 ELSE 5 END FROM inst_criterios;
UPDATE inst_evaluaciones
   SET promedio = (SELECT p FROM (SELECT ROUND(AVG(puntaje), 2) AS p FROM inst_respuestas WHERE evaluacion_id = 1) x)
 WHERE id = 1;

-- Comprobación: 4 áreas con su promedio y nivel
SELECT periodo, area, evaluaciones, promedio, nivel FROM v_inst_area ORDER BY orden;
