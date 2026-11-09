-- Produits phytosanitaires, interventions et produits utilisés par intervention.
-- Existantes en production : créées seulement si absentes.
-- Le stock est décrémenté/restauré par le serveur à chaque intervention.

CREATE TABLE IF NOT EXISTS phyto_products (
  id int(11) NOT NULL AUTO_INCREMENT,
  name varchar(255) NOT NULL,
  category varchar(100) DEFAULT NULL,
  stock float DEFAULT 0,
  unit varchar(50) DEFAULT NULL,
  notes longtext DEFAULT NULL,
  created_at timestamp NULL DEFAULT current_timestamp(),
  updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (id),
  KEY idx_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS phyto_applications (
  id int(11) NOT NULL AUTO_INCREMENT,
  date date NOT NULL,
  notes longtext DEFAULT NULL,
  created_at timestamp NULL DEFAULT current_timestamp(),
  updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (id),
  KEY idx_date (date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS phyto_application_products (
  id int(11) NOT NULL AUTO_INCREMENT,
  application_id int(11) NOT NULL,
  product_id int(11) NOT NULL,
  quantity_used float DEFAULT NULL,
  created_at timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (id),
  KEY idx_application_id (application_id),
  KEY idx_product_id (product_id),
  CONSTRAINT fk_app_application FOREIGN KEY (application_id) REFERENCES phyto_applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_app_product FOREIGN KEY (product_id) REFERENCES phyto_products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
