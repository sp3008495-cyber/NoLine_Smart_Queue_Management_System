-- 1. Create and select the database
CREATE DATABASE IF NOT EXISTS smart_queue;
USE smart_queue;

-- 2. Drop existing tables in correct order of dependency
DROP TABLE IF EXISTS queue_tokens;
DROP TABLE IF EXISTS staff;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS services;

-- 3. Services / Departments Table
CREATE TABLE services (
    service_id INT AUTO_INCREMENT PRIMARY KEY,
    service_name VARCHAR(100) NOT NULL,
    counter_number VARCHAR(50) NOT NULL,
    avg_wait_time INT NOT NULL DEFAULT 5, -- minutes per patient
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert Core Hospital OPD Departments
INSERT INTO services (service_id, service_name, counter_number, avg_wait_time) VALUES
(1, 'Doctor Consultation', 'Counter 3', 10),
(2, 'Blood Test / Pathology', 'Counter 1', 5),
(3, 'Medicine Collection', 'Counter 2', 4),
(4, 'Billing & Registration', 'Counter 4', 3);

-- 4. Patients Table (Users)
CREATE TABLE users (
    user_id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(50) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    gender VARCHAR(20) DEFAULT 'N/A',
    age INT DEFAULT 0,
    priority VARCHAR(30) DEFAULT 'Regular', -- 'Regular', 'Senior Citizen', 'PwD', 'Pregnant', 'Emergency'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. Staff Table (Supports Doctors & Counter Desk Staff via department_id)
CREATE TABLE staff (
    staff_id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(50) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    specialty VARCHAR(50) NOT NULL,
    hospital_branch VARCHAR(100) NOT NULL,
    department_id INT DEFAULT 1,
    is_available BOOLEAN DEFAULT TRUE,
    unavailability_reason VARCHAR(255) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (department_id) REFERENCES services(service_id) ON DELETE SET NULL
);

-- 6. Live OPD Queue Tokens Table (Supports Chained Sub-Tokens & Offline Scan Check-ins)
CREATE TABLE queue_tokens (
    token_id INT AUTO_INCREMENT PRIMARY KEY,
    token_number VARCHAR(30) NOT NULL,
    service_id INT,
    staff_id INT,
    user_id INT,
    hospital_branch VARCHAR(100) NOT NULL,
    status ENUM('Waiting', 'Called', 'Completed', 'Cancelled') DEFAULT 'Waiting',
    people_ahead INT DEFAULT 0,
    checked_in_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES services(service_id) ON DELETE SET NULL,
    FOREIGN KEY (staff_id) REFERENCES staff(staff_id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL
);