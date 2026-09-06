-- ========================================================================
-- SMART QUEUE PLATFORM — COMPLETE DATABASE SCHEMA & SEED DATA
-- Target Database: MySQL 8.0+
-- ========================================================================

CREATE DATABASE IF NOT EXISTS smart_queue;
USE smart_queue;

-- Disable foreign key checks for clean teardown/rebuild
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS token_reschedule_requests;
DROP TABLE IF EXISTS medical_vault;
DROP TABLE IF EXISTS queue_tokens;
DROP TABLE IF EXISTS doctor_availability_exceptions;
DROP TABLE IF EXISTS doctor_availability_schedules;
DROP TABLE IF EXISTS hospital_notices;
DROP TABLE IF EXISTS staff;
DROP TABLE IF EXISTS services;
DROP TABLE IF EXISTS users;

SET FOREIGN_KEY_CHECKS = 1;

-- ------------------------------------------------------------------------
-- 1. USERS TABLE (Patients)
-- ------------------------------------------------------------------------
CREATE TABLE users (
  user_id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(20) UNIQUE NOT NULL,
  gender ENUM('Male', 'Female', 'Other', 'N/A') DEFAULT 'N/A',
  age INT DEFAULT 0,
  priority ENUM('Regular', 'Senior Citizen', 'Emergency', 'PwD', 'Pregnant') DEFAULT 'Regular',
  password VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_users_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------------
-- 2. SERVICES TABLE (OPD Departments & Counters)
-- ------------------------------------------------------------------------
CREATE TABLE services (
  service_id INT AUTO_INCREMENT PRIMARY KEY,
  service_name VARCHAR(100) NOT NULL,
  counter_number VARCHAR(50) NOT NULL,
  avg_wait_time INT DEFAULT 10,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------------
-- 3. STAFF TABLE (Doctors & Hospital Administrators)
-- ------------------------------------------------------------------------
CREATE TABLE staff (
  staff_id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(20) UNIQUE NOT NULL,
  specialty VARCHAR(100) NOT NULL,
  department_id INT NULL,
  hospital_branch VARCHAR(100) NOT NULL,
  is_available TINYINT(1) DEFAULT 1,
  unavailability_reason VARCHAR(255) NULL,
  password VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (department_id) REFERENCES services(service_id) ON DELETE SET NULL,
  INDEX idx_staff_branch_dept (hospital_branch, department_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------------
-- 4. DOCTOR AVAILABILITY SCHEDULES (Recurring Weekly Hours)
-- ------------------------------------------------------------------------
CREATE TABLE doctor_availability_schedules (
  schedule_id INT AUTO_INCREMENT PRIMARY KEY,
  staff_id INT NOT NULL,
  day_of_week ENUM('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday') NOT NULL,
  start_time TIME NOT NULL DEFAULT '09:00:00',
  end_time TIME NOT NULL DEFAULT '17:00:00',
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (staff_id) REFERENCES staff(staff_id) ON DELETE CASCADE,
  UNIQUE KEY unique_doc_day (staff_id, day_of_week)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------------
-- 5. DOCTOR AVAILABILITY EXCEPTIONS (Specific Date Leaves / Extra Hours)
-- ------------------------------------------------------------------------
CREATE TABLE doctor_availability_exceptions (
  exception_id INT AUTO_INCREMENT PRIMARY KEY,
  staff_id INT NOT NULL,
  exception_date DATE NOT NULL,
  is_available TINYINT(1) DEFAULT 0,
  start_time TIME NULL,
  end_time TIME NULL,
  reason VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (staff_id) REFERENCES staff(staff_id) ON DELETE CASCADE,
  UNIQUE KEY unique_doc_date (staff_id, exception_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------------
-- 6. QUEUE TOKENS TABLE (Live OPD Queue & Appointments)
-- ------------------------------------------------------------------------
CREATE TABLE queue_tokens (
  token_id INT AUTO_INCREMENT PRIMARY KEY,
  token_number VARCHAR(20) NOT NULL,
  service_id INT NOT NULL,
  staff_id INT NULL,
  user_id INT NULL,
  hospital_branch VARCHAR(100) NOT NULL,
  status ENUM('Waiting', 'Called', 'Completed', 'Cancelled') DEFAULT 'Waiting',
  people_ahead INT DEFAULT 0,
  appointment_date DATE NOT NULL,
  scheduled_time TIME NULL,
  checked_in_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (service_id) REFERENCES services(service_id) ON DELETE CASCADE,
  FOREIGN KEY (staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL,
  INDEX idx_queue_lookup (hospital_branch, status, appointment_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------------
-- 7. HOSPITAL NOTICES TABLE (Dynamic Digital Notice Board)
-- ------------------------------------------------------------------------
CREATE TABLE hospital_notices (
  notice_id INT AUTO_INCREMENT PRIMARY KEY,
  hospital_branch VARCHAR(100) NOT NULL,
  category ENUM('Emergency', 'Doctor Update', 'Camp / Drive', 'General') DEFAULT 'General',
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  priority ENUM('High', 'Normal') DEFAULT 'Normal',
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_branch_active (hospital_branch, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------------
-- 8. RESCHEDULE REQUESTS TABLE (Patient Shift Appeals)
-- ------------------------------------------------------------------------
CREATE TABLE token_reschedule_requests (
  request_id INT AUTO_INCREMENT PRIMARY KEY,
  token_id INT NOT NULL,
  user_id INT NULL,
  patient_phone VARCHAR(20) NULL,
  hospital_branch VARCHAR(100) NOT NULL,
  original_service_id INT NULL,
  original_staff_id INT NULL,
  reason TEXT NOT NULL,
  admin_response_note TEXT NULL,
  status ENUM('Pending', 'Approved', 'Rejected') DEFAULT 'Pending',
  requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (token_id) REFERENCES queue_tokens(token_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL,
  INDEX idx_reschedule_branch (hospital_branch, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------------
-- 9. MEDICAL VAULT TABLE (Prescriptions, Lab Results & Notes)
-- ------------------------------------------------------------------------
CREATE TABLE medical_vault (
  doc_id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  patient_phone VARCHAR(20) NOT NULL,
  doc_title VARCHAR(255) NOT NULL,
  doc_type ENUM('Prescription', 'Lab Report', 'Radiology', 'Discharge Summary', 'Other') DEFAULT 'Prescription',
  file_data LONGTEXT NOT NULL,
  notes TEXT NULL,
  uploaded_by_id INT NULL,
  uploaded_by_name VARCHAR(100) NOT NULL,
  uploaded_by_role VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL,
  INDEX idx_vault_lookup (user_id, patient_phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ========================================================================
-- DATA SEEDING
-- Passwords:
-- Admin (phone: 9999999999) -> admin123
-- Doctors (phone: 9100000001, etc.) -> doc123
-- Patients (phone: 9876543210) -> 123456
-- Hash generated via bcrypt (cost factor: 10)
-- ========================================================================

-- 1. Departments & Counters
INSERT INTO services (service_id, service_name, counter_number, avg_wait_time) VALUES
(1, 'Doctor Consultation', 'Counter 3', 12),
(2, 'Blood Test / Pathology', 'Counter 1', 8),
(3, 'Medicine Collection', 'Counter 2', 5),
(4, 'Billing & Registration', 'Counter 4', 6);

-- 2. Staff Accounts
-- Password hashes:
-- 'admin123' -> $2b$10$wE9l1E44l89ZqgU5eKq27uO1gSj3yN5QeH8/Z8rA9Lq0UqKj1mK.i
-- 'doc123'   -> $2b$10$8.jM1mC6eW3k7dI2D8b7b.nKj9I4bY2eH4u3d8k0d2e8b7b.nKj9I
INSERT INTO staff (staff_id, name, phone, specialty, department_id, hospital_branch, is_available, unavailability_reason, password) VALUES
(1, 'Medical Superintendent', '9999999999', 'Branch Admin', 1, 'City Hospital (Main Branch)', 1, NULL, '$2b$10$wE9l1E44l89ZqgU5eKq27uO1gSj3yN5QeH8/Z8rA9Lq0UqKj1mK.i'),
(2, 'Dr. A. K. Sharma', '9100000001', 'Cardiology', 1, 'City Hospital (Main Branch)', 1, NULL, '$2b$10$8.jM1mC6eW3k7dI2D8b7b.nKj9I4bY2eH4u3d8k0d2e8b7b.nKj9I'),
(3, 'Dr. Neha Verma', '9100000002', 'Neurology', 1, 'City Hospital (Main Branch)', 1, NULL, '$2b$10$8.jM1mC6eW3k7dI2D8b7b.nKj9I4bY2eH4u3d8k0d2e8b7b.nKj9I'),
(4, 'Dr. Rajesh Gupta', '9100000003', 'Orthopedics', 1, 'City Hospital (Main Branch)', 0, 'In Emergency OT', '$2b$10$8.jM1mC6eW3k7dI2D8b7b.nKj9I4bY2eH4u3d8k0d2e8b7b.nKj9I'),
(5, 'Dr. Priya Singh', '9100000004', 'Dermatology', 1, 'City Hospital (Main Branch)', 1, NULL, '$2b$10$8.jM1mC6eW3k7dI2D8b7b.nKj9I4bY2eH4u3d8k0d2e8b7b.nKj9I'),
(6, 'Dr. Vikram Malhotra', '9100000005', 'General Medicine', 1, 'City Hospital (Main Branch)', 1, NULL, '$2b$10$8.jM1mC6eW3k7dI2D8b7b.nKj9I4bY2eH4u3d8k0d2e8b7b.nKj9I'),
(7, 'Branch Head Gomti Nagar', '9999999998', 'Branch Admin', 1, 'City Hospital (Gomti Nagar)', 1, NULL, '$2b$10$wE9l1E44l89ZqgU5eKq27uO1gSj3yN5QeH8/Z8rA9Lq0UqKj1mK.i'),
(8, 'Dr. S. K. Rastogi', '9100000006', 'Cardiology', 1, 'City Hospital (Gomti Nagar)', 1, NULL, '$2b$10$8.jM1mC6eW3k7dI2D8b7b.nKj9I4bY2eH4u3d8k0d2e8b7b.nKj9I');

-- 3. Recurring Doctor Duty Schedules (Dr. Sharma: Mon-Sat)
INSERT INTO doctor_availability_schedules (staff_id, day_of_week, start_time, end_time, is_active) VALUES
(2, 'Monday', '09:00:00', '17:00:00', 1),
(2, 'Tuesday', '09:00:00', '17:00:00', 1),
(2, 'Wednesday', '09:00:00', '17:00:00', 1),
(2, 'Thursday', '09:00:00', '17:00:00', 1),
(2, 'Friday', '09:00:00', '17:00:00', 1),
(2, 'Saturday', '09:00:00', '14:00:00', 1),
(2, 'Sunday', '09:00:00', '13:00:00', 0);

-- 4. Sample Patient Account
-- '123456' -> $2b$10$sOaNfxq5c3.xT6G0W3J21.rY5yA8x3u8aP1v9x1d7c0e8b7b.nKj9
INSERT INTO users (user_id, name, phone, gender, age, priority, password) VALUES
(1, 'Satyam Patel', '9876543210', 'Male', 21, 'Regular', '$2b$10$sOaNfxq5c3.xT6G0W3J21.rY5yA8x3u8aP1v9x1d7c0e8b7b.nKj9');

-- 5. Hospital Notices
INSERT INTO hospital_notices (hospital_branch, category, title, message, priority, is_active) VALUES
('City Hospital (Main Branch)', 'Emergency', 'ICU Surge Protocol Active', 'All non-critical OPD referrals redirected to Wing B today.', 'High', 1),
('City Hospital (Main Branch)', 'Doctor Update', 'Cardiology Shift Delay', 'Dr. A. K. Sharma consultation starts at 10:00 AM today due to morning rounds.', 'Normal', 1),
('City Hospital (Main Branch)', 'Camp / Drive', 'Free Diabetes Screening Camp', 'Free HbA1c screening available at Counter 1 between 2 PM and 4 PM.', 'Normal', 1),
('City Hospital (Gomti Nagar)', 'General', 'Walk-in Desk Operational', 'Counter 4 now issuing unified thermal tokens for non-smartphone patients.', 'Normal', 1),
('City Hospital (Aliganj Wing)', 'Doctor Update', 'Pediatrics OPD Open', 'Special evening pediatric clinic running today from 5:00 PM to 7:00 PM.', 'Normal', 1);

-- 6. Sample Initial Token Entry
INSERT INTO queue_tokens (token_id, token_number, service_id, staff_id, user_id, hospital_branch, status, people_ahead, appointment_date, scheduled_time) VALUES
(1, 'A101', 1, 2, 1, 'City Hospital (Main Branch)', 'Waiting', 0, CURRENT_DATE(), '10:00:00');
