
USE sia_demo;

CREATE OR REPLACE VIEW v_horarios AS
SELECT g.id AS grupo_id, g.clave AS grupo, m.nombre AS materia, d.nombre AS docente,
       h.dia_semana, h.hora_inicio, h.hora_fin, h.aula, g.periodo_id
  FROM horarios h
  JOIN grupos g    ON g.id = h.grupo_id
  JOIN materias m  ON m.id = g.materia_id
  JOIN docentes d  ON d.id = g.docente_id;

CREATE OR REPLACE VIEW v_reporte_periodo_programa AS
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
 
 SHOW FULL TABLES IN sia_demo WHERE Table_type = 'VIEW';
 
 SELECT * FROM sia_demo.v_horarios WHERE grupo = 'BD701';
SELECT * FROM sia_demo.v_reporte_periodo_programa;

SELECT * FROM sia_demo.grupos;
SELECT * FROM sia_demo.materias;

SELECT COUNT(*) FROM sia_demo.inscripciones WHERE estatus = 'INSCRITO';