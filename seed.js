require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');

async function seedDatabase() {
  console.log('🌱 Starting staff, doctor & admin account seeding...');
  const plainPassword = process.env.DEFAULT_DOCTOR_PASSWORD || 'doc123';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

  try {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME
    });

    const staffPasswordHash = await bcrypt.hash(plainPassword, 10);
    const adminPasswordHash = await bcrypt.hash(adminPassword, 10);

    // 1. Doctors (department_id = 1, Counter 3)
    const doctors = [
      // Main Branch
      ['Dr. A. K. Sharma (Cardiologist)', '9100000001', 'Cardiology', 'City Hospital (Main Branch)', 1],
      ['Dr. R. P. Verma (Neurologist)', '9100000002', 'Neurology', 'City Hospital (Main Branch)', 1],
      ['Dr. S. K. Gupta (Orthopedic)', '9100000003', 'Orthopedics', 'City Hospital (Main Branch)', 1],
      ['Dr. Priya Singh (Dermatologist)', '9100000004', 'Dermatology', 'City Hospital (Main Branch)', 1],
      ['Dr. Vikas Roy (General Physician)', '9100000005', 'General Medicine', 'City Hospital (Main Branch)', 1],

      // Gomti Nagar
      ['Dr. Manish Mehta (Cardiologist)', '9200000001', 'Cardiology', 'City Hospital (Gomti Nagar)', 1],
      ['Dr. Neha Kapoor (Neurologist)', '9200000002', 'Neurology', 'City Hospital (Gomti Nagar)', 1],
      ['Dr. Amit Joshi (Orthopedic)', '9200000003', 'Orthopedics', 'City Hospital (Gomti Nagar)', 1],
      ['Dr. Shalini Saxena (Dermatologist)', '9200000004', 'Dermatology', 'City Hospital (Gomti Nagar)', 1],
      ['Dr. Tarun Kumar (General Physician)', '9200000005', 'General Medicine', 'City Hospital (Gomti Nagar)', 1],

      // Aliganj Wing
      ['Dr. Sanjay Rastogi (Cardiologist)', '9300000001', 'Cardiology', 'City Hospital (Aliganj Wing)', 1],
      ['Dr. Pooja Bhatia (Neurologist)', '9300000002', 'Neurology', 'City Hospital (Aliganj Wing)', 1],
      ['Dr. Harsh Vardhan (Orthopedic)', '9300000003', 'Orthopedics', 'City Hospital (Aliganj Wing)', 1],
      ['Dr. Ritu Agarwal (Dermatologist)', '9300000004', 'Dermatology', 'City Hospital (Aliganj Wing)', 1],
      ['Dr. Alok Mishra (General Physician)', '9300000005', 'General Medicine', 'City Hospital (Aliganj Wing)', 1],

      // Indira Nagar
      ['Dr. K. N. Pandey (Cardiologist)', '9400000001', 'Cardiology', 'City Hospital (Indira Nagar)', 1],
      ['Dr. Ananya Sen (Neurologist)', '9400000002', 'Neurology', 'City Hospital (Indira Nagar)', 1],
      ['Dr. Sunil Grover (Orthopedic)', '9400000003', 'Orthopedics', 'City Hospital (Indira Nagar)', 1],
      ['Dr. Meenakshi Roy (Dermatologist)', '9400000004', 'Dermatology', 'City Hospital (Indira Nagar)', 1],
      ['Dr. Rajesh Khanna (General Physician)', '9400000005', 'General Medicine', 'City Hospital (Indira Nagar)', 1],

      // Charbagh
      ['Dr. V. C. Tripathi (Cardiologist)', '9500000001', 'Cardiology', 'City Hospital (Charbagh)', 1],
      ['Dr. Smita Tiwari (Neurologist)', '9500000002', 'Neurology', 'City Hospital (Charbagh)', 1],
      ['Dr. Deepak Nanda (Orthopedic)', '9500000003', 'Orthopedics', 'City Hospital (Charbagh)', 1],
      ['Dr. Sunita Reddy (Dermatologist)', '9500000004', 'Dermatology', 'City Hospital (Charbagh)', 1],
      ['Dr. G. S. Rathore (General Physician)', '9500000005', 'General Medicine', 'City Hospital (Charbagh)', 1]
    ];

    // 2. Department Staff Logins (2: Pathology, 3: Pharmacy, 4: Billing)
    const counterStaff = [
      ['Pathology Lab Technician', '9100000020', 'Lab Diagnostics', 'City Hospital (Main Branch)', 2],
      ['Pharmacist In-Charge', '9100000030', 'Pharmacy Dispensing', 'City Hospital (Main Branch)', 3],
      ['Billing & Cashier Desk', '9100000040', 'Billing Desk', 'City Hospital (Main Branch)', 4]
    ];

    const allStaff = [...doctors, ...counterStaff];

    for (const member of allStaff) {
      await connection.execute(
        `INSERT INTO staff (name, phone, password, specialty, hospital_branch, department_id, is_available)
         VALUES (?, ?, ?, ?, ?, ?, TRUE)
         ON DUPLICATE KEY UPDATE 
           name = VALUES(name),
           password = VALUES(password),
           specialty = VALUES(specialty),
           hospital_branch = VALUES(hospital_branch),
           department_id = VALUES(department_id),
           is_available = VALUES(is_available)`,
        [member[0], member[1], staffPasswordHash, member[2], member[3], member[4]]
      );
    }

    // 3. Super Admin User Account
    await connection.execute(
      `INSERT INTO staff (name, phone, password, specialty, hospital_branch, department_id, is_available)
       VALUES ('Network Super Admin', '9999999999', ?, 'Super Admin', 'All Branches', NULL, TRUE)
       ON DUPLICATE KEY UPDATE 
         password = VALUES(password),
         specialty = 'Super Admin'`,
      [adminPasswordHash]
    );

    console.log('✅ Success: Seeded doctors, counter staff, and Super Admin ');
    await connection.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Seeding failed:', error.message);
    process.exit(1);
  }
}

seedDatabase();