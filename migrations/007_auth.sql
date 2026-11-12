-- Phase 9: Authentication & User Management
-- Users table for Microsoft SSO + local auth

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    password_hash TEXT NOT NULL DEFAULT '$2a$10$' || repeat('x', 53),
    role VARCHAR(20) NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user', 'viewer')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    microsoft_id TEXT UNIQUE,
    display_name TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_microsoft_id ON users(microsoft_id) WHERE microsoft_id IS NOT NULL;
