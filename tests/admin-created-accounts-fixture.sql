-- TEST FIXTURE ONLY: a minimal local schema, never a production migration.
CREATE TABLE users (
  id int AUTO_INCREMENT PRIMARY KEY, openId varchar(64) NOT NULL UNIQUE,
  customerId varchar(10) NOT NULL UNIQUE, name text, email varchar(320), emailNormalized varchar(320) UNIQUE,
  givenName varchar(100), fatherName varchar(100), phoneNumber varchar(20), phoneNormalized varchar(20) UNIQUE,
  phoneVerifiedAt timestamp NULL, birthDate varchar(10), governorate varchar(40), nationalIdCiphertext text,
  nationalIdLast4 varchar(4), nationalIdFingerprint varchar(64) UNIQUE, securityPinHash varchar(256),
  securityPinUpdatedAt timestamp NULL, profileCompletedAt timestamp NULL, loginMethod varchar(64),
  role enum('user','admin') NOT NULL DEFAULT 'user', status enum('active','deleted') NOT NULL DEFAULT 'active', deletedAt timestamp NULL,
  createdAt timestamp NOT NULL DEFAULT current_timestamp(), updatedAt timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  lastSignedIn timestamp NOT NULL DEFAULT current_timestamp(), lastOpenedAt timestamp NULL, appVersion varchar(32), appBuildNumber varchar(48)
) ENGINE=InnoDB;
CREATE TABLE auth_password_credentials (
  userId int PRIMARY KEY, passwordHash varchar(255) NOT NULL, emailVerifiedAt timestamp NOT NULL,
  phoneVerifiedAt timestamp NULL, createdAt timestamp NOT NULL DEFAULT current_timestamp(),
  updatedAt timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB;
CREATE TABLE app_settings (`key` varchar(80) PRIMARY KEY, `value` text NOT NULL, updatedBy int,
  updatedAt timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()) ENGINE=InnoDB;
CREATE TABLE account_verifications (id int AUTO_INCREMENT PRIMARY KEY, userId int NOT NULL UNIQUE,
  status enum('pending','approved','rejected') NOT NULL, nameSnapshot text NOT NULL, emailSnapshot varchar(320),
  phoneNumberSnapshot varchar(20) NOT NULL, birthDateSnapshot varchar(10) NOT NULL, nationalIdFingerprint varchar(64) NOT NULL,
  rejectionReason text, submittedAt timestamp NULL, reviewedAt timestamp NULL, reviewedBy int) ENGINE=InnoDB;
CREATE TABLE account_verification_overrides (userId int PRIMARY KEY, status enum('manual_verified','revoked') NOT NULL,
  reason text, updatedAt timestamp NULL, adminId int) ENGINE=InnoDB;
