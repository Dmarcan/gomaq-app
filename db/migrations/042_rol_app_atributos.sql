-- Refuerzo de la 041: si el rol `gomaq_app` ya existia con atributos amplios (porque alguien lo creo a mano
-- antes), el CREATE ROLE de la 041 no lo toco y los GRANT/REVOKE no limitan lo que ese atributo permite.
-- Se dejan explicitamente los atributos de privilegio apagados. No toca LOGIN ni la clave: eso lo
-- se activa en Railway.
ALTER ROLE gomaq_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
