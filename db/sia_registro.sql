-- =====================================================================
-- SIA · Registro de cuentas con correo de activación
-- Ejecutar UNA vez sobre la base sia_demo ya existente
-- (después de sia_base_datos.sql y del módulo de evaluación).
-- =====================================================================
USE sia_demo;

-- 1. Campos para el enlace de activación
--    · token_activacion: se guarda el HASH (SHA-256) del enlace, nunca el enlace tal cual
--    · token_expira:     el enlace vence a las 24 horas
--    · creado:           fecha en que se registró la cuenta
ALTER TABLE usuarios
  ADD COLUMN token_activacion CHAR(64) NULL AFTER activo,
  ADD COLUMN token_expira     DATETIME NULL AFTER token_activacion,
  ADD COLUMN creado           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER token_expira,
  ADD UNIQUE INDEX uq_usuarios_token (token_activacion);

-- 2. Una sola cuenta por alumno y una sola por docente
--    (MySQL permite varios NULL en un índice UNIQUE, así que el ADMIN no estorba)
ALTER TABLE usuarios
  ADD UNIQUE INDEX uq_usuarios_alumno  (alumno_id),
  ADD UNIQUE INDEX uq_usuarios_docente (docente_id);

-- 3. Las cuentas nuevas nacen INACTIVAS hasta que abren el enlace del correo.
--    Las cuentas que ya existen (admin, María Torres y Daniela) siguen activas.
ALTER TABLE usuarios ALTER COLUMN activo SET DEFAULT FALSE;

-- Comprobación: deben salir las 3 cuentas demo con activo = 1 y token vacío
SELECT id, email, rol, activo, token_activacion, token_expira, creado FROM usuarios;
