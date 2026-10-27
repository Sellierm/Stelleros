-- Tables d'authentification (schéma Better Auth, plugin username).
-- Le serveur Rust lit et écrit ces tables ; il ne les crée pas.
CREATE TABLE IF NOT EXISTS auth_user (
  id varchar(36) NOT NULL,
  name varchar(255) NOT NULL,
  email varchar(255) NOT NULL,
  emailVerified tinyint(1) NOT NULL,
  image text DEFAULT NULL,
  createdAt timestamp(3) NOT NULL DEFAULT current_timestamp(3),
  updatedAt timestamp(3) NOT NULL DEFAULT current_timestamp(3),
  username varchar(255) DEFAULT NULL,
  displayUsername text DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY email (email),
  UNIQUE KEY username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS auth_session (
  id varchar(36) NOT NULL,
  expiresAt timestamp(3) NOT NULL,
  token varchar(255) NOT NULL,
  createdAt timestamp(3) NOT NULL DEFAULT current_timestamp(3),
  updatedAt timestamp(3) NOT NULL,
  ipAddress text DEFAULT NULL,
  userAgent text DEFAULT NULL,
  userId varchar(36) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY token (token),
  KEY auth_session_userId_idx (userId),
  CONSTRAINT auth_session_ibfk_1 FOREIGN KEY (userId) REFERENCES auth_user (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS auth_account (
  id varchar(36) NOT NULL,
  accountId text NOT NULL,
  providerId text NOT NULL,
  userId varchar(36) NOT NULL,
  accessToken text DEFAULT NULL,
  refreshToken text DEFAULT NULL,
  idToken text DEFAULT NULL,
  accessTokenExpiresAt timestamp(3) NULL DEFAULT NULL,
  refreshTokenExpiresAt timestamp(3) NULL DEFAULT NULL,
  scope text DEFAULT NULL,
  password text DEFAULT NULL,
  createdAt timestamp(3) NOT NULL DEFAULT current_timestamp(3),
  updatedAt timestamp(3) NOT NULL,
  PRIMARY KEY (id),
  KEY auth_account_userId_idx (userId),
  CONSTRAINT auth_account_ibfk_1 FOREIGN KEY (userId) REFERENCES auth_user (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS auth_verification (
  id varchar(36) NOT NULL,
  identifier varchar(255) NOT NULL,
  value text NOT NULL,
  expiresAt timestamp(3) NOT NULL,
  createdAt timestamp(3) NOT NULL DEFAULT current_timestamp(3),
  updatedAt timestamp(3) NOT NULL DEFAULT current_timestamp(3),
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
