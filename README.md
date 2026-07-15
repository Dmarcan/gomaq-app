# GOMAQ

Sistema de Gestion y Comunicacion Centralizado para empresa de arriendo de maquinarias.

## Estructura

- `backend/` - API REST (Node.js + Express + PostgreSQL)
- `db/schema.sql` - Esquema inicial de base de datos
- `mobile/` - App Flutter (pendiente)

## Backend - desarrollo local

```bash
cd backend
cp .env.example .env   # ajustar credenciales de PostgreSQL
npm install
npm run dev
```

## Base de datos

```bash
sudo -u postgres createuser gomaq_user -P
sudo -u postgres createdb gomaq -O gomaq_user
psql -U gomaq_user -d gomaq -f db/schema.sql
```
