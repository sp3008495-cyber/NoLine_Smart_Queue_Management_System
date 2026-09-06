require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(cors());
app.use(express.static(__dirname));

const JWT_SECRET = process.env.JWT_SECRET || 'hospital_opd_secret_jwt_key_2026_secure';
const PASS_SIGNING_SECRET = process.env.PASS_SIGNING_SECRET
  || crypto.createHash('sha256').update(`${JWT_SECRET}::pass-signing`).digest('hex');

const MAX_DOCTOR_DAILY_CAPACITY = 30;

function signTokenPass(tokenId, tokenNumber, generatedAt) {
  return crypto
    .createHmac('sha256', PASS_SIGNING_SECRET)
    .update(`${tokenId}:${tokenNumber}:${generatedAt}`)
    .digest('hex')
    .slice(0, 24);
}

function dispatchSimulatedSMS(phoneNumber, message) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`\n================== 📱 SIMULATED SMS DISPATCH [${timestamp}] ==================`);
  console.log(`Recipient: +91-${phoneNumber}`);
  console.log(`Message:\n${message}`);
  console.log(`===========================================================================\n`);
}

const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'smart_queue',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

db.getConnection()
  .then(async conn => {
    console.log('✅ Connected to MySQL Database successfully!');
    
    // Auto-create hospital_notices table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS hospital_notices (
        notice_id INT AUTO_INCREMENT PRIMARY KEY,
        hospital_branch VARCHAR(100) NOT NULL,
        category ENUM('Emergency', 'Doctor Update', 'Camp / Drive', 'General') DEFAULT 'General',
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        priority ENUM('High', 'Normal') DEFAULT 'Normal',
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_branch_active (hospital_branch, is_active)
      )
    `);

    // Auto-create token_reschedule_requests table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS token_reschedule_requests (
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
        requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    conn.release();
  })
  .catch(err => console.error('❌ Database initialization error:', err.message));

const KIOSK_PIN = process.env.KIOSK_PIN || '4127';

// ---------------- AUTH MIDDLEWARES ----------------

const verifyDoctorStrict = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Doctor authentication token required.' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err || decoded.role !== 'Doctor') {
      return res.status(403).json({ error: 'Access denied: Valid Doctor privileges required.' });
    }
    req.staff = decoded;
    next();
  });
};

const verifyPatient = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Patient authentication required.' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err || decoded.role !== 'Patient') {
      return res.status(403).json({ error: 'Access denied: Valid Patient session required.' });
    }
    req.patient = decoded;
    next();
  });
};

const verifyAnyUser = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication token required.' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired session.' });
    req.userAuth = decoded;
    next();
  });
};

const verifyHospitalAdminStrict = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Admin authentication token required.' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err || (decoded.role !== 'BranchAdmin' && decoded.role !== 'SuperAdmin')) {
      return res.status(403).json({ error: 'Access denied: Hospital Administrator privileges strictly required.' });
    }
    req.adminUser = decoded;
    next();
  });
};

const verifyKiosk = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(403).json({ valid: false, error: 'Kiosk not authenticated.' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err || decoded.role !== 'Kiosk') {
      return res.status(403).json({ valid: false, error: 'Kiosk session expired.' });
    }
    next();
  });
};

// ---------------- AUTHENTICATION & LOGIN ----------------

app.post('/api/kiosk/auth', (req, res) => {
  const { pin } = req.body;
  if (pin !== KIOSK_PIN) return res.status(401).json({ error: 'Incorrect kiosk PIN.' });
  const token = jwt.sign({ role: 'Kiosk' }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password, hospitalBranch } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Phone and password required.' });

    const [staff] = await db.execute(
      `SELECT s.*, svc.service_name, svc.counter_number 
       FROM staff s 
       LEFT JOIN services svc ON s.department_id = svc.service_id 
       WHERE s.phone = ?`,
      [phone]
    );

    if (staff.length > 0) {
      const member = staff[0];

      if (await bcrypt.compare(password, member.password)) {
        const isHospitalAdmin = ['Super Admin', 'Branch Admin', 'Hospital Administrator'].includes(member.specialty);
        
        if (isHospitalAdmin) {
          const roleType = member.specialty === 'Super Admin' ? 'SuperAdmin' : 'BranchAdmin';
          const assignedBranch = member.hospital_branch || hospitalBranch || 'City Hospital (Main Branch)';

          const token = jwt.sign(
            { staffId: member.staff_id, name: member.name, role: roleType, branch: assignedBranch },
            JWT_SECRET,
            { expiresIn: '12h' }
          );

          return res.json({
            role: roleType,
            token,
            user: {
              id: member.staff_id,
              name: member.name,
              phone: member.phone,
              specialty: member.specialty,
              branch: assignedBranch
            }
          });
        }

        if (hospitalBranch && member.hospital_branch !== hospitalBranch) {
          return res.status(403).json({
            error: `Access Denied: ${member.name} belongs to ${member.hospital_branch}, not ${hospitalBranch}.`
          });
        }

        const token = jwt.sign(
          {
            staffId: member.staff_id,
            name: member.name,
            role: 'Doctor',
            specialty: member.specialty,
            branch: member.hospital_branch,
            departmentId: member.department_id,
            phone: member.phone
          },
          JWT_SECRET, { expiresIn: '12h' }
        );

        return res.json({
          role: 'Doctor',
          token,
          user: {
            id: member.staff_id,
            name: member.name,
            phone: member.phone,
            specialty: member.specialty,
            branch: member.hospital_branch,
            departmentId: member.department_id,
            serviceName: member.service_name || 'Doctor Consultation',
            counterNumber: member.counter_number || 'Counter 3',
            isAvailable: !!member.is_available,
            unavailabilityReason: member.unavailability_reason
          }
        });
      }
    }

    const [users] = await db.execute('SELECT * FROM users WHERE phone = ?', [phone]);
    if (users.length > 0) {
      if (await bcrypt.compare(password, users[0].password)) {
        const token = jwt.sign(
          { userId: users[0].user_id, name: users[0].name, role: 'Patient', phone: users[0].phone },
          JWT_SECRET, { expiresIn: '12h' }
        );
        return res.json({ role: 'Patient', token, user: { id: users[0].user_id, name: users[0].name, phone: users[0].phone } });
      }
    }

    res.status(401).json({ error: 'Invalid phone or password.' });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, phone, password, gender, age, priority } = req.body;
    const hash = await bcrypt.hash(password || '123456', 10);

    const [resDb] = await db.execute(
      `INSERT INTO users (name, phone, gender, age, priority, password) VALUES (?, ?, ?, ?, ?, ?)`,
      [name, phone, gender || 'N/A', age || 0, priority || 'Regular', hash]
    );

    const token = jwt.sign({ userId: resDb.insertId, name, role: 'Patient', phone }, JWT_SECRET, { expiresIn: '12h' });
    res.status(201).json({ role: 'Patient', token, user: { id: resDb.insertId, name, phone } });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Phone number already registered.' });
    res.status(500).json({ error: err.message });
  }
});

// ---------------- HOSPITAL NOTICE BOARD ENDPOINTS ----------------

// Public Read (notice-board.html & ticker widgets)
app.get('/api/notices', async (req, res) => {
  try {
    const branch = req.query.branch || 'City Hospital (Main Branch)';
    const [notices] = await db.execute(
      `SELECT notice_id, hospital_branch, category, title, message, priority, 
              DATE_FORMAT(created_at, '%d %b, %h:%i %p') AS posted_time
       FROM hospital_notices
       WHERE hospital_branch = ? AND is_active = 1
       ORDER BY CASE WHEN priority = 'High' THEN 1 ELSE 2 END, created_at DESC
       LIMIT 10`,
      [branch]
    );

    res.json({ success: true, branch, notices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Read (Full active + archived notice inspection)
app.get('/api/admin/notices', verifyHospitalAdminStrict, async (req, res) => {
  try {
    const branch = req.query.branch || req.adminUser.branch;
    const [notices] = await db.execute(
      `SELECT notice_id, hospital_branch, category, title, message, priority, is_active,
              DATE_FORMAT(created_at, '%d %b %Y, %h:%i %p') AS posted_time
       FROM hospital_notices
       WHERE hospital_branch = ?
       ORDER BY created_at DESC`,
      [branch]
    );
    res.json({ success: true, branch, notices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Publish Notice
app.post('/api/admin/notices', verifyHospitalAdminStrict, async (req, res) => {
  try {
    const { hospitalBranch, category, title, message, priority } = req.body;
    const targetBranch = hospitalBranch || req.adminUser.branch;

    if (!targetBranch || !title || !message) {
      return res.status(400).json({ error: 'Branch, title, and message are strictly required.' });
    }

    const [result] = await db.execute(
      `INSERT INTO hospital_notices (hospital_branch, category, title, message, priority)
       VALUES (?, ?, ?, ?, ?)`,
      [targetBranch, category || 'General', title, message, priority || 'Normal']
    );

    res.status(201).json({ 
      success: true, 
      message: `Notice published successfully for ${targetBranch}!`, 
      noticeId: result.insertId 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Update / Archive / Restore Notice
app.patch('/api/admin/notices/:id', verifyHospitalAdminStrict, async (req, res) => {
  try {
    const { title, message, category, priority, isActive } = req.body;
    const noticeId = req.params.id;

    await db.execute(
      `UPDATE hospital_notices 
       SET title = COALESCE(?, title),
           message = COALESCE(?, message),
           category = COALESCE(?, category),
           priority = COALESCE(?, priority),
           is_active = COALESCE(?, is_active)
       WHERE notice_id = ?`,
      [
        title !== undefined ? title : null, 
        message !== undefined ? message : null, 
        category !== undefined ? category : null, 
        priority !== undefined ? priority : null, 
        isActive !== undefined ? isActive : null, 
        noticeId
      ]
    );

    res.json({ success: true, message: 'Notice updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Delete Notice
app.delete('/api/admin/notices/:id', verifyHospitalAdminStrict, async (req, res) => {
  try {
    await db.execute(`DELETE FROM hospital_notices WHERE notice_id = ?`, [req.params.id]);
    res.json({ success: true, message: 'Notice deleted permanently.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- BRANCH ADMIN DASHBOARD APIs ----------------

app.get('/api/branch-admin/analytics', verifyHospitalAdminStrict, async (req, res) => {
  try {
    const branch = req.query.branch || req.adminUser.branch;
    const todayStr = new Date().toISOString().split('T')[0];

    const [tokenStats] = await db.execute(
      `SELECT 
         COUNT(*) AS total_today,
         SUM(CASE WHEN status = 'Waiting' THEN 1 ELSE 0 END) AS waiting_count,
         SUM(CASE WHEN status = 'Called' THEN 1 ELSE 0 END) AS serving_count,
         SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) AS completed_count,
         SUM(CASE WHEN status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled_count
       FROM queue_tokens
       WHERE hospital_branch = ? AND (appointment_date = ? OR DATE(created_at) = ?)`,
      [branch, todayStr, todayStr]
    );

    const [doctorStats] = await db.execute(
      `SELECT 
         COUNT(*) AS total_doctors,
         SUM(CASE WHEN is_available = 1 THEN 1 ELSE 0 END) AS on_duty_doctors
       FROM staff
       WHERE hospital_branch = ? AND department_id = 1`,
      [branch]
    );

    const [triage] = await db.execute(
      `SELECT COALESCE(u.priority, 'Regular') AS priority, COUNT(*) AS count
       FROM queue_tokens t
       LEFT JOIN users u ON t.user_id = u.user_id
       WHERE t.hospital_branch = ? AND (t.appointment_date = ? OR DATE(t.created_at) = ?)
       GROUP BY u.priority`,
      [branch, todayStr, todayStr]
    );

    const [rescheduleCount] = await db.execute(
      `SELECT COUNT(*) AS count FROM token_reschedule_requests WHERE hospital_branch = ? AND status = 'Pending'`,
      [branch]
    );

    res.json({
      success: true,
      tokens: tokenStats[0],
      doctors: doctorStats[0],
      triage,
      pendingReschedules: rescheduleCount[0].count
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/branch-admin/doctors', verifyHospitalAdminStrict, async (req, res) => {
  try {
    const branch = req.query.branch || req.adminUser.branch;
    const [doctors] = await db.execute(
      `SELECT staff_id, name, phone, specialty, is_available, unavailability_reason 
       FROM staff 
       WHERE hospital_branch = ? AND department_id = 1
       ORDER BY name ASC`,
      [branch]
    );
    res.json(doctors);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/branch-admin/doctors', verifyHospitalAdminStrict, async (req, res) => {
  try {
    const { name, phone, specialty, password, hospitalBranch } = req.body;
    const targetBranch = hospitalBranch || req.adminUser.branch;

    if (!name || !phone || !password) {
      return res.status(400).json({ error: 'Name, phone, and password required.' });
    }

    const hash = await bcrypt.hash(password, 10);
    await db.execute(
      `INSERT INTO staff (name, phone, specialty, department_id, hospital_branch, is_available, password)
       VALUES (?, ?, ?, 1, ?, 1, ?)`,
      [name, phone, specialty || 'General Medicine', targetBranch, hash]
    );

    res.status(201).json({ success: true, message: `Doctor ${name} successfully assigned to ${targetBranch}!` });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Phone number already assigned to another doctor.' });
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/branch-admin/doctors/:id', verifyHospitalAdminStrict, async (req, res) => {
  try {
    const { confirmationName } = req.body;
    const staffId = req.params.id;

    const [doc] = await db.execute(`SELECT name FROM staff WHERE staff_id = ?`, [staffId]);
    if (doc.length === 0) return res.status(404).json({ error: 'Doctor not found.' });

    if (!confirmationName || confirmationName.toLowerCase() !== doc[0].name.toLowerCase()) {
      return res.status(400).json({ error: 'Confirmation name did not match.' });
    }

    await db.execute(`DELETE FROM staff WHERE staff_id = ?`, [staffId]);
    res.json({ success: true, message: `Doctor ${doc[0].name} removed from roster.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/branch-admin/reschedule-requests', verifyHospitalAdminStrict, async (req, res) => {
  try {
    const branch = req.query.branch || req.adminUser.branch;
    const [requests] = await db.execute(
      `SELECT r.request_id, r.token_id, r.user_id, r.patient_phone, r.reason, r.admin_response_note, r.status,
              DATE_FORMAT(r.requested_at, '%h:%i %p') AS requested_time,
              t.token_number, u.name AS patient_name
       FROM token_reschedule_requests r
       LEFT JOIN queue_tokens t ON r.token_id = t.token_id
       LEFT JOIN users u ON r.user_id = u.user_id
       WHERE r.hospital_branch = ?
       ORDER BY CASE WHEN r.status = 'Pending' THEN 1 ELSE 2 END, r.requested_at DESC`,
      [branch]
    );
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/branch-admin/reschedule-requests/:id', verifyHospitalAdminStrict, async (req, res) => {
  try {
    const { action, responseNote } = req.body;
    const requestId = req.params.id;

    await db.execute(
      `UPDATE token_reschedule_requests SET status = ?, admin_response_note = ? WHERE request_id = ?`,
      [action, responseNote || null, requestId]
    );

    res.json({ success: true, message: `Reschedule request #${requestId} marked as ${action}!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- DOCTOR AVAILABILITY ENGINE ----------------

async function evaluateDoctorAvailability(staffId, targetDate, targetTimeStr) {
  const [docRows] = await db.execute(
    `SELECT is_available, unavailability_reason, name FROM staff WHERE staff_id = ?`,
    [staffId]
  );
  if (docRows.length === 0) return { available: false, reason: 'Doctor record not found.' };

  const doc = docRows[0];
  if (!doc.is_available) {
    return { available: false, reason: `${doc.name} is currently off-duty (${doc.unavailability_reason || 'Unavailable'}).` };
  }

  const [exceptions] = await db.execute(
    `SELECT is_available, start_time, end_time, reason 
     FROM doctor_availability_exceptions 
     WHERE staff_id = ? AND exception_date = ?`,
    [staffId, targetDate]
  );

  if (exceptions.length > 0) {
    const exc = exceptions[0];
    if (!exc.is_available) {
      return { available: false, reason: `${doc.name} is unavailable on ${targetDate}: ${exc.reason || 'On Leave'}.` };
    }
    if (targetTimeStr && exc.start_time && exc.end_time) {
      if (targetTimeStr < exc.start_time || targetTimeStr > exc.end_time) {
        return { available: false, reason: `${doc.name} is only available on ${targetDate} between ${exc.start_time} and ${exc.end_time}.` };
      }
    }
    return { available: true, reason: 'Special working slot.' };
  }

  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const [year, month, day] = targetDate.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  const dayName = days[d.getDay()];

  const [schedules] = await db.execute(
    `SELECT is_active, start_time, end_time 
     FROM doctor_availability_schedules 
     WHERE staff_id = ? AND day_of_week = ?`,
    [staffId, dayName]
  );

  if (schedules.length > 0) {
    const sched = schedules[0];
    if (!sched.is_active) {
      return { available: false, reason: `${doc.name} does not have consultation hours on ${dayName}s.` };
    }
    if (targetTimeStr) {
      if (targetTimeStr < sched.start_time || targetTimeStr > sched.end_time) {
        return { available: false, reason: `${doc.name} consultations on ${dayName}s are between ${sched.start_time} and ${sched.end_time}.` };
      }
    }
    return { available: true, dayName, startTime: sched.start_time, endTime: sched.end_time };
  }

  if (dayName === 'Sunday') {
    return { available: false, reason: `${doc.name} is closed on Sundays.` };
  }

  return { available: true, dayName, startTime: '09:00:00', endTime: '17:00:00' };
}

app.get('/api/doctor/availability', verifyDoctorStrict, async (req, res) => {
  try {
    const staffId = req.staff.staffId;
    const [staffRows] = await db.execute(`SELECT is_available, unavailability_reason FROM staff WHERE staff_id = ?`, [staffId]);
    const [schedules] = await db.execute(`SELECT schedule_id, day_of_week, start_time, end_time, is_active FROM doctor_availability_schedules WHERE staff_id = ? ORDER BY FIELD(day_of_week, 'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')`, [staffId]);
    const [exceptions] = await db.execute(`SELECT exception_id, DATE_FORMAT(exception_date, '%Y-%m-%d') AS exception_date, is_available, start_time, end_time, reason FROM doctor_availability_exceptions WHERE staff_id = ? AND exception_date >= CURRENT_DATE() - INTERVAL 1 DAY ORDER BY exception_date ASC`, [staffId]);

    res.json({
      success: true,
      globalStatus: { isAvailable: !!staffRows[0].is_available, unavailabilityReason: staffRows[0].unavailability_reason },
      schedules,
      exceptions
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/doctor/availability/global', verifyDoctorStrict, async (req, res) => {
  try {
    const staffId = req.staff.staffId;
    const { isAvailable, reason } = req.body;

    if (!isAvailable && (!reason || reason.trim().length === 0)) {
      return res.status(400).json({ error: 'Please specify an unavailability reason.' });
    }

    await db.execute(`UPDATE staff SET is_available = ?, unavailability_reason = ? WHERE staff_id = ?`, [isAvailable ? 1 : 0, isAvailable ? null : reason.trim(), staffId]);
    res.json({ success: true, message: `Status updated to ${isAvailable ? 'Available' : 'Unavailable'}.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/doctor/availability/schedules', verifyDoctorStrict, async (req, res) => {
  try {
    const staffId = req.staff.staffId;
    const { schedules } = req.body;
    if (!Array.isArray(schedules) || schedules.length === 0) return res.status(400).json({ error: 'Invalid schedules payload.' });

    for (const item of schedules) {
      await db.execute(
        `INSERT INTO doctor_availability_schedules (staff_id, day_of_week, start_time, end_time, is_active)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE start_time = VALUES(start_time), end_time = VALUES(end_time), is_active = VALUES(is_active)`,
        [staffId, item.day_of_week, item.start_time || '09:00:00', item.end_time || '17:00:00', item.is_active ? 1 : 0]
      );
    }
    res.json({ success: true, message: 'Recurring weekly schedules updated!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/doctor/availability/exceptions', verifyDoctorStrict, async (req, res) => {
  try {
    const staffId = req.staff.staffId;
    const { exceptionDate, isAvailable, startTime, endTime, reason } = req.body;
    if (!exceptionDate) return res.status(400).json({ error: 'Exception date required.' });

    await db.execute(
      `INSERT INTO doctor_availability_exceptions (staff_id, exception_date, is_available, start_time, end_time, reason)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE is_available = VALUES(is_available), start_time = VALUES(start_time), end_time = VALUES(end_time), reason = VALUES(reason)`,
      [staffId, exceptionDate, isAvailable ? 1 : 0, startTime || null, endTime || null, reason || 'Leave']
    );
    res.status(201).json({ success: true, message: `Date exception saved for ${exceptionDate}!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/doctor/availability/exceptions/:id', verifyDoctorStrict, async (req, res) => {
  try {
    await db.execute(`DELETE FROM doctor_availability_exceptions WHERE exception_id = ? AND staff_id = ?`, [req.params.id, req.staff.staffId]);
    res.json({ success: true, message: 'Exception removed.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/doctors/branch', async (req, res) => {
  try {
    const branch = req.query.branch || 'City Hospital (Main Branch)';
    const targetDate = req.query.date || new Date().toISOString().split('T')[0];

    const [doctors] = await db.execute(
      `SELECT staff_id, name, specialty, is_available, unavailability_reason 
       FROM staff 
       WHERE hospital_branch = ? AND department_id = 1`,
      [branch]
    );

    const enrichedDoctors = await Promise.all(doctors.map(async (doc) => {
      const [sched] = await db.execute(
        `SELECT day_of_week, TIME_FORMAT(start_time, '%h:%i %p') AS start_time, 
                TIME_FORMAT(end_time, '%h:%i %p') AS end_time 
         FROM doctor_availability_schedules 
         WHERE staff_id = ? AND is_active = 1 
         ORDER BY FIELD(day_of_week, 'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')`,
        [doc.staff_id]
      );

      const evaluation = await evaluateDoctorAvailability(doc.staff_id, targetDate, null);

      return {
        ...doc,
        evaluatedAvailability: evaluation.available,
        effectiveReason: evaluation.available ? null : evaluation.reason,
        activeSchedules: sched
      };
    }));

    res.json(enrichedDoctors);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------- TOKEN GENERATION & BOOKING ----------------

app.post('/api/tokens/generate', async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const { serviceName, userId, hospitalBranch, staffId, appointmentDate, scheduledTime } = req.body;
    
    const [services] = await connection.execute('SELECT * FROM services WHERE service_name = ?', [serviceName]);
    if (services.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Service department not found.' });
    }

    const service = services[0];
    const branch = hospitalBranch || 'City Hospital (Main Branch)';
    const targetDate = appointmentDate || new Date().toISOString().split('T')[0];
    const targetTime = scheduledTime || new Date().toTimeString().split(' ')[0].slice(0, 5) + ':00';

    const todayStr = new Date().toISOString().split('T')[0];
    if (targetDate < todayStr) {
      await connection.rollback();
      return res.status(400).json({ error: 'Cannot book appointments for past dates.' });
    }

    let doctorInfo = null;

    if (service.service_id === 1) {
      if (!staffId) {
        await connection.rollback();
        return res.status(400).json({ error: 'Please select a specific doctor for consultation.' });
      }

      const evalResult = await evaluateDoctorAvailability(staffId, targetDate, targetTime);
      if (!evalResult.available) {
        await connection.rollback();
        return res.status(400).json({ error: evalResult.reason });
      }

      if (userId) {
        const [existing] = await connection.execute(
          `SELECT token_id, token_number FROM queue_tokens 
           WHERE user_id = ? 
             AND staff_id = ? 
             AND (appointment_date = ? OR DATE(created_at) = ?) 
             AND status IN ('Waiting', 'Called')`,
          [userId, staffId, targetDate, targetDate]
        );
        if (existing.length > 0) {
          await connection.rollback();
          return res.status(400).json({ 
            error: `You already have an active appointment (Token ${existing[0].token_number}) with this doctor on ${targetDate}.` 
          });
        }
      }

      const [docCountRows] = await connection.execute(
        `SELECT COUNT(*) AS total_booked FROM queue_tokens 
         WHERE staff_id = ? 
           AND (appointment_date = ? OR DATE(created_at) = ?) 
           AND status IN ('Waiting', 'Called', 'Completed')`,
        [staffId, targetDate, targetDate]
      );
      if (docCountRows[0].total_booked >= MAX_DOCTOR_DAILY_CAPACITY) {
        await connection.rollback();
        return res.status(400).json({ error: `Doctor consultation queue is full for ${targetDate} (Max capacity reached).` });
      }

      const [dRows] = await connection.execute('SELECT name, specialty FROM staff WHERE staff_id = ?', [staffId]);
      doctorInfo = dRows[0];
    }

    let prefix = 'A';
    if (service.service_id === 2) prefix = 'B';
    if (service.service_id === 3) prefix = 'C';
    if (service.service_id === 4) prefix = 'D';

    let countQuery = `SELECT COUNT(*) AS total_tokens FROM queue_tokens WHERE service_id = ? AND hospital_branch = ? AND (appointment_date = ? OR DATE(created_at) = ?)`;
    let countParams = [service.service_id, branch, targetDate, targetDate];

    if (staffId && service.service_id === 1) {
      countQuery += ` AND staff_id = ?`;
      countParams.push(staffId);
    }

    const [countRows] = await connection.execute(countQuery, countParams);
    const tokenSeq = countRows[0].total_tokens + 1;
    const tokenNumber = `${prefix}10${tokenSeq}`;

    const [waiting] = await connection.execute(
      `SELECT COUNT(*) AS count FROM queue_tokens 
       WHERE service_id = ? AND hospital_branch = ? AND (appointment_date = ? OR DATE(created_at) = ?) AND status = 'Waiting'`,
      [service.service_id, branch, targetDate, targetDate]
    );
    const peopleAhead = waiting[0].count;
    const estimatedWaitMins = (peopleAhead * service.avg_wait_time) + 2;

    const [insertResult] = await connection.execute(
      `INSERT INTO queue_tokens 
       (token_number, service_id, staff_id, user_id, hospital_branch, status, people_ahead, appointment_date, scheduled_time) 
       VALUES (?, ?, ?, ?, ?, 'Waiting', ?, ?, ?)`,
      [tokenNumber, service.service_id, staffId || null, userId || null, branch, peopleAhead, targetDate, targetTime]
    );

    const tokenId = insertResult.insertId;
    const [createdRows] = await connection.execute('SELECT created_at FROM queue_tokens WHERE token_id = ?', [tokenId]);
    const generatedAt = Math.floor(new Date(createdRows[0].created_at).getTime() / 1000);

    await connection.commit();

    res.status(201).json({
      success: true,
      tokenId,
      tokenNumber,
      serviceName: service.service_name,
      doctorName: doctorInfo ? doctorInfo.name : null,
      specialization: doctorInfo ? doctorInfo.specialty : null,
      counter: service.counter_number,
      hospitalBranch: branch,
      appointmentDate: targetDate,
      scheduledTime: targetTime.slice(0, 5),
      peopleAhead,
      estimatedWaitMins,
      generatedAt,
      passHash: signTokenPass(tokenId, tokenNumber, generatedAt)
    });
  } catch (err) {
    await connection.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    connection.release();
  }
});

// ---------------- DOCTOR QUEUE ACTIONS ----------------

app.get('/api/queue/doctor/live', verifyDoctorStrict, async (req, res) => {
  try {
    const staffId = req.staff.staffId;
    const branch = req.staff.branch;
    const todayStr = new Date().toISOString().split('T')[0];

    const [calledRows] = await db.execute(
      `SELECT t.token_id, t.token_number, t.status, 
              COALESCE(t.appointment_date, DATE(t.created_at)) AS appointment_date,
              TIME_FORMAT(t.scheduled_time, '%h:%i %p') AS scheduled_time,
              u.name AS patient_name, u.phone AS patient_phone, 
              COALESCE(u.priority, 'Regular') AS priority
       FROM queue_tokens t
       LEFT JOIN users u ON t.user_id = u.user_id
       WHERE t.staff_id = ? 
         AND t.hospital_branch = ? 
         AND t.status = 'Called'
         AND (t.appointment_date = ? OR DATE(t.created_at) = ?)
       LIMIT 1`,
      [staffId, branch, todayStr, todayStr]
    );

    const [waitingRows] = await db.execute(
      `SELECT t.token_id, t.token_number, t.status, 
              COALESCE(t.appointment_date, DATE(t.created_at)) AS appointment_date,
              TIME_FORMAT(t.scheduled_time, '%h:%i %p') AS scheduled_time,
              u.name AS patient_name, u.phone AS patient_phone, 
              COALESCE(u.priority, 'Regular') AS priority,
              ROW_NUMBER() OVER (
                ORDER BY CASE 
                  WHEN u.priority = 'Emergency' THEN 1
                  WHEN u.priority IN ('Senior Citizen', 'PwD', 'Pregnant') THEN 2
                  ELSE 3
                END, t.token_id ASC
              ) AS queue_position
       FROM queue_tokens t
       LEFT JOIN users u ON t.user_id = u.user_id
       WHERE t.staff_id = ? 
         AND t.hospital_branch = ? 
         AND t.status = 'Waiting'
         AND (t.appointment_date = ? OR DATE(t.created_at) = ?)
       ORDER BY queue_position ASC`,
      [staffId, branch, todayStr, todayStr]
    );

    const [stats] = await db.execute(
      `SELECT 
         COUNT(*) AS total_issued,
         SUM(CASE WHEN status = 'Waiting' THEN 1 ELSE 0 END) AS waiting_count,
         SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) AS completed_count,
         SUM(CASE WHEN status = 'Waiting' AND u.priority = 'Emergency' THEN 1 ELSE 0 END) AS emergency_count,
         SUM(CASE WHEN status = 'Waiting' AND u.priority IN ('Senior Citizen','PwD','Pregnant') THEN 1 ELSE 0 END) AS senior_count
       FROM queue_tokens t
       LEFT JOIN users u ON t.user_id = u.user_id
       WHERE t.staff_id = ? 
         AND t.hospital_branch = ? 
         AND (t.appointment_date = ? OR DATE(t.created_at) = ?)`,
      [staffId, branch, todayStr, todayStr]
    );

    res.json({
      success: true,
      currentPatient: calledRows.length > 0 ? calledRows[0] : null,
      waitingQueue: waitingRows,
      stats: {
        totalIssued: stats[0].total_issued || 0,
        waitingCount: stats[0].waiting_count || 0,
        completedCount: stats[0].completed_count || 0,
        emergencyCount: stats[0].emergency_count || 0,
        seniorCount: stats[0].senior_count || 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/queue/doctor/call-next', verifyDoctorStrict, async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const staffId = req.staff.staffId;
    const branch = req.staff.branch;
    const todayStr = new Date().toISOString().split('T')[0];

    const [currentlyCalled] = await connection.execute(
      `SELECT token_id, token_number FROM queue_tokens 
       WHERE staff_id = ? AND hospital_branch = ? AND status = 'Called' 
         AND (appointment_date = ? OR DATE(created_at) = ?) FOR UPDATE`,
      [staffId, branch, todayStr, todayStr]
    );

    if (currentlyCalled.length > 0) {
      await connection.rollback();
      return res.status(400).json({ 
        error: `Please finish consultation for Token ${currentlyCalled[0].token_number} before calling the next patient.` 
      });
    }

    const [nextCandidates] = await connection.execute(
      `SELECT t.token_id, t.token_number, u.phone, u.name 
       FROM queue_tokens t
       LEFT JOIN users u ON t.user_id = u.user_id
       WHERE t.staff_id = ? 
         AND t.hospital_branch = ? 
         AND t.status = 'Waiting'
         AND (t.appointment_date = ? OR DATE(t.created_at) = ?)
       ORDER BY CASE 
         WHEN u.priority = 'Emergency' THEN 1
         WHEN u.priority IN ('Senior Citizen', 'PwD', 'Pregnant') THEN 2
         ELSE 3
       END, t.token_id ASC 
       LIMIT 1 FOR UPDATE`,
      [staffId, branch, todayStr, todayStr]
    );

    if (nextCandidates.length === 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'No waiting patients in your queue.' });
    }

    const nextPatient = nextCandidates[0];

    await connection.execute(
      `UPDATE queue_tokens SET status = 'Called' WHERE token_id = ?`,
      [nextPatient.token_id]
    );

    await connection.commit();

    const callAlertText = `🚨 OPD Live Call: Token ${nextPatient.token_number} is now being called! Please proceed to Counter 3 immediately.`;
    dispatchSimulatedSMS(nextPatient.phone || '9999999999', callAlertText);

    res.json({
      success: true,
      message: `Token ${nextPatient.token_number} called successfully!`,
      calledToken: nextPatient
    });
  } catch (err) {
    await connection.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    connection.release();
  }
});

app.post('/api/queue/doctor/complete', verifyDoctorStrict, async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const staffId = req.staff.staffId;
    const branch = req.staff.branch;
    const { tokenId, prescribeLab, prescribePharmacy } = req.body;

    const [calledRows] = await connection.execute(
      `SELECT token_id, token_number, user_id, hospital_branch 
       FROM queue_tokens 
       WHERE token_id = ? AND staff_id = ? AND status = 'Called' FOR UPDATE`,
      [tokenId, staffId]
    );

    if (calledRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Active consultation token not found.' });
    }

    const parent = calledRows[0];
    const chainedTokens = [];

    await connection.execute(
      `UPDATE queue_tokens SET status = 'Completed' WHERE token_id = ?`,
      [parent.token_id]
    );

    if (prescribeLab) {
      const subTokenLab = `${parent.token_number}-LAB`;
      await connection.execute(
        `INSERT INTO queue_tokens (token_number, service_id, user_id, hospital_branch, status, appointment_date, scheduled_time) 
         VALUES (?, 2, ?, ?, 'Waiting', CURRENT_DATE(), CURRENT_TIME())`,
        [subTokenLab, parent.user_id, branch]
      );
      chainedTokens.push({ service: 'Pathology Lab (Counter 1)', tokenNumber: subTokenLab });
    }

    if (prescribePharmacy) {
      const subTokenPharm = `${parent.token_number}-PHARM`;
      await connection.execute(
        `INSERT INTO queue_tokens (token_number, service_id, user_id, hospital_branch, status, appointment_date, scheduled_time) 
         VALUES (?, 3, ?, ?, 'Waiting', CURRENT_DATE(), CURRENT_TIME())`,
        [subTokenPharm, parent.user_id, branch]
      );
      chainedTokens.push({ service: 'Pharmacy (Counter 2)', tokenNumber: subTokenPharm });
    }

    await connection.commit();

    res.json({
      success: true,
      message: `Consultation for Token ${parent.token_number} completed.`,
      chainedTokens
    });
  } catch (err) {
    await connection.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    connection.release();
  }
});

app.post('/api/queue/doctor/no-show', verifyDoctorStrict, async (req, res) => {
  try {
    const staffId = req.staff.staffId;
    const { tokenId } = req.body;

    const [rows] = await db.execute(
      `UPDATE queue_tokens SET status = 'Cancelled' 
       WHERE token_id = ? AND staff_id = ? AND status = 'Called'`,
      [tokenId, staffId]
    );

    if (rows.affectedRows === 0) {
      return res.status(404).json({ error: 'Active called patient token not found.' });
    }

    res.json({ success: true, message: 'Patient marked as No-Show / Cancelled.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/queue/patient/status/:tokenId', verifyPatient, async (req, res) => {
  try {
    const tokenId = req.params.tokenId;
    const userId = req.patient.userId;

    const [tokenRows] = await db.execute(
      `SELECT t.token_id, t.token_number, t.status, t.staff_id, t.hospital_branch, 
              COALESCE(t.appointment_date, DATE(t.created_at)) AS appointment_date,
              TIME_FORMAT(t.scheduled_time, '%h:%i %p') AS scheduled_time,
              s.service_name, s.counter_number, s.avg_wait_time,
              st.name AS doctor_name, st.specialty AS specialization
       FROM queue_tokens t
       LEFT JOIN services s ON t.service_id = s.service_id
       LEFT JOIN staff st ON t.staff_id = st.staff_id
       WHERE t.token_id = ? AND t.user_id = ?`,
      [tokenId, userId]
    );

    if (tokenRows.length === 0) return res.status(404).json({ error: 'Appointment token not found.' });
    const token = tokenRows[0];

    const [currentCalled] = await db.execute(
      `SELECT token_number FROM queue_tokens 
       WHERE staff_id = ? AND hospital_branch = ? AND status = 'Called' 
         AND (appointment_date = ? OR DATE(created_at) = ?) LIMIT 1`,
      [token.staff_id, token.hospital_branch, token.appointment_date, token.appointment_date]
    );

    const [aheadRows] = await db.execute(
      `SELECT COUNT(*) AS count FROM queue_tokens 
       WHERE staff_id = ? AND hospital_branch = ? AND status = 'Waiting' 
         AND (appointment_date = ? OR DATE(created_at) = ?)
         AND token_id < ?`,
      [token.staff_id, token.hospital_branch, token.appointment_date, token.appointment_date, token.token_id]
    );

    const peopleAhead = aheadRows[0].count;
    const estimatedWaitMins = (peopleAhead * (token.avg_wait_time || 12)) + (currentCalled.length > 0 ? 3 : 0);

    res.json({
      success: true,
      tokenNumber: token.token_number,
      status: token.status,
      doctorName: token.doctor_name,
      specialization: token.specialization,
      counter: token.counter_number,
      nowServing: currentCalled.length > 0 ? currentCalled[0].token_number : '--',
      peopleAhead,
      estimatedWaitMins
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- IVR HELPLINE ENDPOINTS ----------------

app.get('/api/ivr/earliest-slot', async (req, res) => {
  try {
    const branch = req.query.branch || 'City Hospital (Main Branch)';
    let staffId = req.query.staffId ? parseInt(req.query.staffId) : null;

    let docQuery = `SELECT staff_id, name, specialty, is_available, unavailability_reason 
                    FROM staff WHERE hospital_branch = ? AND department_id = 1`;
    let docParams = [branch];

    if (staffId) {
      docQuery += ` AND staff_id = ?`;
      docParams.push(staffId);
    } else {
      docQuery += ` AND is_available = 1 LIMIT 1`;
    }

    let [doctors] = await db.execute(docQuery, docParams);

    if (doctors.length === 0) {
      const [fallbackDocs] = await db.execute(
        `SELECT staff_id, name, specialty, is_available, unavailability_reason 
         FROM staff WHERE hospital_branch = ? AND department_id = 1 LIMIT 1`,
        [branch]
      );
      doctors = fallbackDocs;
    }

    if (doctors.length === 0) {
      return res.status(404).json({ available: false, error: 'No specialists found at this branch.' });
    }

    const doctor = doctors[0];
    const now = new Date();
    let targetDate = now.toISOString().split('T')[0];
    let isNextDay = false;

    if (now.getHours() >= 17) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      targetDate = tomorrow.toISOString().split('T')[0];
      isNextDay = true;
    }

    const [bookedRows] = await db.execute(
      `SELECT TIME_FORMAT(scheduled_time, '%H:%i') AS slot_time 
       FROM queue_tokens 
       WHERE staff_id = ? AND (appointment_date = ? OR DATE(created_at) = ?) AND status IN ('Waiting', 'Called')`,
      [doctor.staff_id, targetDate, targetDate]
    );

    const bookedSet = new Set(bookedRows.map(r => r.slot_time));
    let chosenSlot = null;
    let currH = 9, currM = 0;

    const currentH = isNextDay ? 0 : now.getHours();
    const currentM = isNextDay ? 0 : now.getMinutes();

    while (currH < 17) {
      const slotStr = `${String(currH).padStart(2, '0')}:${String(currM).padStart(2, '0')}`;
      const isPast = (currH < currentH) || (currH === currentH && currM <= currentM);

      if (!isPast && !bookedSet.has(slotStr)) {
        chosenSlot = slotStr;
        break;
      }

      currM += 15;
      if (currM >= 60) {
        currH += Math.floor(currM / 60);
        currM = currM % 60;
      }
    }

    if (!chosenSlot) {
      return res.status(400).json({ 
        available: false, 
        error: `All slots with ${doctor.name} are fully booked for ${isNextDay ? 'tomorrow' : 'today'}.` 
      });
    }

    res.json({
      available: true,
      doctor,
      earliestSlot: chosenSlot,
      date: targetDate,
      isTomorrow: isNextDay
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ivr/book-token', async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const { staffId, hospitalBranch, scheduledTime, patientPhone } = req.body;
    const phone = patientPhone || '9876543210';
    const targetDate = new Date().toISOString().split('T')[0];

    let [users] = await connection.execute('SELECT user_id, name FROM users WHERE phone = ?', [phone]);
    let userId;
    let patientName = `Caller-${phone.slice(-4)}`;

    if (users.length === 0) {
      const defaultHash = await bcrypt.hash('ivr123', 10);
      const [resDb] = await connection.execute(
        `INSERT INTO users (name, phone, gender, age, priority, password) VALUES (?, ?, 'N/A', 0, 'Regular', ?)`,
        [patientName, phone, defaultHash]
      );
      userId = resDb.insertId;
    } else {
      userId = users[0].user_id;
      patientName = users[0].name;
    }

    const [existing] = await connection.execute(
      `SELECT token_number FROM queue_tokens 
       WHERE user_id = ? AND staff_id = ? AND (appointment_date = ? OR DATE(created_at) = ?) AND status IN ('Waiting', 'Called')`,
      [userId, staffId, targetDate, targetDate]
    );

    if (existing.length > 0) {
      await connection.rollback();
      return res.status(400).json({ error: `You already have active Token ${existing[0].token_number} with this doctor today.` });
    }

    const [countRows] = await connection.execute(
      `SELECT COUNT(*) AS total FROM queue_tokens 
       WHERE service_id = 1 AND staff_id = ? AND (appointment_date = ? OR DATE(created_at) = ?)`,
      [staffId, targetDate, targetDate]
    );
    const tokenNumber = `A10${countRows[0].total + 1}`;

    const [waiting] = await connection.execute(
      `SELECT COUNT(*) AS count FROM queue_tokens 
       WHERE service_id = 1 AND hospital_branch = ? AND (appointment_date = ? OR DATE(created_at) = ?) AND status = 'Waiting'`,
      [hospitalBranch, targetDate, targetDate]
    );
    const peopleAhead = waiting[0].count;

    const [insertResult] = await connection.execute(
      `INSERT INTO queue_tokens 
       (token_number, service_id, staff_id, user_id, hospital_branch, status, people_ahead, appointment_date, scheduled_time) 
       VALUES (?, 1, ?, ?, ?, 'Waiting', ?, ?, ?)`,
      [tokenNumber, staffId, userId, hospitalBranch, peopleAhead, targetDate, `${scheduledTime}:00`]
    );

    const tokenId = insertResult.insertId;
    const generatedAt = Math.floor(Date.now() / 1000);
    const passHash = signTokenPass(tokenId, tokenNumber, generatedAt);

    await connection.commit();

    const [doc] = await db.execute('SELECT name FROM staff WHERE staff_id = ?', [staffId]);
    const smsMessage = `✅ City Hospital Appointment Confirmed!\nToken: ${tokenNumber}\nDoctor: ${doc[0].name}\nSlot: ${scheduledTime} today\nCounter: Counter 3\nPlease arrive 10 mins early.`;
    dispatchSimulatedSMS(phone, smsMessage);

    res.status(201).json({
      success: true,
      tokenId,
      tokenNumber,
      patientName,
      doctorName: doc[0].name,
      appointmentDate: targetDate,
      scheduledTime,
      passHash,
      generatedAt,
      simulatedSMS: smsMessage
    });
  } catch (err) {
    await connection.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    connection.release();
  }
});

// ---------------- PATIENT PROFILE & VAULT ----------------

app.get('/api/patient/active-token', verifyPatient, async (req, res) => {
  try {
    const userId = req.patient.userId;
    const todayStr = new Date().toISOString().split('T')[0];

    const [rows] = await db.execute(
      `SELECT t.token_id, t.token_number, t.status, t.hospital_branch, 
              COALESCE(t.appointment_date, DATE(t.created_at)) AS appointment_date,
              TIME_FORMAT(t.scheduled_time, '%h:%i %p') AS scheduled_time,
              COALESCE(s.service_name, 'Doctor Consultation') AS service_name,
              COALESCE(s.counter_number, 'Counter 3') AS counter_number,
              s.avg_wait_time,
              COALESCE(st.name, 'Assigned Specialist') AS doctor_name,
              COALESCE(st.specialty, 'General Medicine') AS specialization,
              t.created_at
       FROM queue_tokens t
       LEFT JOIN services s ON t.service_id = s.service_id
       LEFT JOIN staff st ON t.staff_id = st.staff_id
       WHERE t.user_id = ? 
         AND (t.appointment_date = ? OR DATE(t.created_at) = ?) 
         AND t.status IN ('Waiting', 'Called')
       ORDER BY t.token_id DESC LIMIT 1`,
      [userId, todayStr, todayStr]
    );

    if (rows.length === 0) {
      return res.json({ success: true, activeToken: null });
    }

    const token = rows[0];
    const generatedAt = Math.floor(new Date(token.created_at).getTime() / 1000);

    const [waiting] = await db.execute(
      `SELECT COUNT(*) AS count FROM queue_tokens 
       WHERE hospital_branch = ? 
         AND (appointment_date = ? OR DATE(created_at) = ?) 
         AND status = 'Waiting' 
         AND token_id < ?`,
      [token.hospital_branch, todayStr, todayStr, token.token_id]
    );
    const peopleAhead = waiting[0].count;
    const estimatedWaitMins = (peopleAhead * (token.avg_wait_time || 12)) + 2;

    res.json({
      success: true,
      activeToken: {
        tokenId: token.token_id,
        tokenNumber: token.token_number,
        serviceName: token.service_name,
        doctorName: token.doctor_name,
        specialization: token.specialization,
        counter: token.counter_number,
        hospitalBranch: token.hospital_branch,
        appointmentDate: token.appointment_date,
        scheduledTime: token.scheduled_time,
        status: token.status,
        peopleAhead,
        estimatedWaitMins,
        generatedAt,
        passHash: signTokenPass(token.token_id, token.token_number, generatedAt)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/patient/profile', verifyPatient, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT user_id, name, phone, gender, age, priority, DATE_FORMAT(created_at, '%d %b %Y') AS member_since 
       FROM users WHERE user_id = ?`,
      [req.patient.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Patient not found.' });
    res.json({ success: true, profile: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/patient/profile', verifyPatient, async (req, res) => {
  try {
    const { name, gender, age } = req.body;
    if (!name || name.trim().length === 0) return res.status(400).json({ error: 'Name cannot be empty.' });
    await db.execute('UPDATE users SET name = ?, gender = ?, age = ? WHERE user_id = ?', [name.trim(), gender || 'N/A', parseInt(age) || 0, req.patient.userId]);
    res.json({ success: true, message: 'Profile updated successfully!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/patient/change-password', verifyPatient, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Valid password (min 6 chars) required.' });
    const [rows] = await db.execute('SELECT password FROM users WHERE user_id = ?', [req.patient.userId]);
    if (rows.length === 0 || !(await bcrypt.compare(oldPassword, rows[0].password))) return res.status(401).json({ error: 'Incorrect current password.' });
    const newHash = await bcrypt.hash(newPassword, 10);
    await db.execute('UPDATE users SET password = ? WHERE user_id = ?', [newHash, req.patient.userId]);
    res.json({ success: true, message: 'Password changed successfully!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/patient/my-appointments', verifyPatient, async (req, res) => {
  try {
    const [appointments] = await db.execute(
      `SELECT t.token_id, t.token_number, t.status, t.hospital_branch,
              COALESCE(s.service_name, 'Doctor Consultation') AS service_name,
              COALESCE(s.counter_number, 'Counter 3') AS counter_number,
              COALESCE(st.name, 'Assigned Specialist') AS doctor_name,
              COALESCE(st.specialty, 'General Medicine') AS specialization,
              DATE_FORMAT(COALESCE(t.appointment_date, DATE(t.created_at)), '%d %b %Y') AS appointment_date,
              TIME_FORMAT(t.scheduled_time, '%h:%i %p') AS scheduled_time
       FROM queue_tokens t
       LEFT JOIN services s ON t.service_id = s.service_id
       LEFT JOIN staff st ON t.staff_id = st.staff_id
       WHERE t.user_id = ?
       ORDER BY t.token_id DESC`,
      [req.patient.userId]
    );
    res.json({ success: true, appointments });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/patient/my-vault', verifyPatient, async (req, res) => {
  try {
    const [records] = await db.execute(
      `SELECT doc_id, doc_title, doc_type, file_data, notes, uploaded_by_name, uploaded_by_role,
              DATE_FORMAT(created_at, '%d %b %Y, %h:%i %p') AS formatted_date
       FROM medical_vault 
       WHERE user_id = ? OR patient_phone = ?
       ORDER BY created_at DESC`,
      [req.patient.userId, req.patient.phone]
    );
    res.json({ success: true, records });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/vault/upload', verifyDoctorStrict, async (req, res) => {
  try {
    const { patientPhone, docTitle, docType, fileData, notes } = req.body;
    const [userRows] = await db.execute('SELECT user_id FROM users WHERE phone = ?', [patientPhone]);
    const userId = userRows.length > 0 ? userRows[0].user_id : null;

    const [result] = await db.execute(
      `INSERT INTO medical_vault (user_id, patient_phone, doc_title, doc_type, file_data, notes, uploaded_by_id, uploaded_by_name, uploaded_by_role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [userId, patientPhone, docTitle, docType || 'Prescription', fileData, notes || '', req.staff.staffId, req.staff.name, `${req.staff.specialty} (${req.staff.branch})`]
    );
    res.status(201).json({ message: 'Medical document uploaded to patient vault!', docId: result.insertId, uploadedBy: req.staff.name, role: req.staff.specialty });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------- DESK, KIOSK & RESCHEDULE TICKETING ----------------

app.post('/api/desk/walkin-token', verifyDoctorStrict, async (req, res) => {
  try {
    const { name, phone, priority, serviceId, staffId } = req.body;
    const branch = req.staff.branch;
    if (!name || !serviceId) return res.status(400).json({ error: 'Patient name and service required.' });

    let userId = null;
    if (phone && phone.trim().length === 10) {
      const [existing] = await db.execute('SELECT user_id FROM users WHERE phone = ?', [phone]);
      userId = existing.length > 0 ? existing[0].user_id : (await db.execute('INSERT INTO users (name, phone, gender, age, priority, password) VALUES (?, ?, \'N/A\', 0, ?, \'walkin123\')', [name, phone, priority || 'Regular']))[0].insertId;
    } else {
      userId = (await db.execute('INSERT INTO users (name, phone, gender, age, priority, password) VALUES (?, NULL, \'N/A\', 0, ?, \'walkin123\')', [name, priority || 'Regular']))[0].insertId;
    }

    const [services] = await db.execute('SELECT * FROM services WHERE service_id = ?', [serviceId]);
    const service = services[0];
    const todayStr = new Date().toISOString().split('T')[0];
    const [todayTokens] = await db.execute('SELECT COUNT(*) AS total_today FROM queue_tokens WHERE service_id = ? AND hospital_branch = ? AND (appointment_date = ? OR DATE(created_at) = ?)', [serviceId, branch, todayStr, todayStr]);
    const tokenNumber = `A10${todayTokens[0].total_today + 1}`;

    const [insertResult] = await db.execute(
      'INSERT INTO queue_tokens (token_number, service_id, staff_id, user_id, hospital_branch, status, people_ahead, appointment_date, scheduled_time) VALUES (?, ?, ?, ?, ?, \'Waiting\', 0, CURRENT_DATE(), CURRENT_TIME())',
      [tokenNumber, serviceId, staffId || null, userId, branch]
    );

    const tokenId = insertResult.insertId;
    const generatedAt = Math.floor(Date.now() / 1000);
    res.status(201).json({ tokenId, tokenNumber, patientName: name, priority: priority || 'Regular', serviceName: service.service_name, counter: service.counter_number, hospitalBranch: branch, generatedAt, passHash: signTokenPass(tokenId, tokenNumber, generatedAt) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tokens/verify', verifyKiosk, async (req, res) => {
  try {
    const { tokenId, tokenNumber, passHash, generatedAt } = req.body;
    if (signTokenPass(tokenId, tokenNumber, generatedAt) !== passHash) return res.status(400).json({ valid: false, error: 'Tampered pass signature.' });

    const [rows] = await db.execute(
      `SELECT t.token_id, t.token_number, t.status, s.service_name, s.counter_number, u.name AS patient_name, t.checked_in_at
       FROM queue_tokens t 
       LEFT JOIN services s ON t.service_id = s.service_id 
       LEFT JOIN users u ON t.user_id = u.user_id 
       WHERE t.token_id = ?`,
      [tokenId]
    );
    if (rows.length === 0) return res.status(404).json({ valid: false, error: 'Token not found.' });
    if (!rows[0].checked_in_at) await db.execute('UPDATE queue_tokens SET checked_in_at = NOW() WHERE token_id = ?', [tokenId]);

    res.json({ valid: true, ...rows[0], alreadyCheckedIn: !rows[0].checked_in_at });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tokens/board', async (req, res) => {
  try {
    const branch = req.query.branch || 'City Hospital (Main Branch)';
    const [called] = await db.execute('SELECT t.token_id, t.token_number, s.service_name, s.counter_number FROM queue_tokens t JOIN services s ON t.service_id = s.service_id WHERE t.hospital_branch = ? AND t.status = \'Called\' AND (t.appointment_date = CURRENT_DATE() OR DATE(t.created_at) = CURRENT_DATE()) ORDER BY t.token_id DESC LIMIT 10', [branch]);
    const [waiting] = await db.execute('SELECT s.service_name, s.counter_number, COUNT(*) AS waiting_count FROM queue_tokens t JOIN services s ON t.service_id = s.service_id WHERE t.hospital_branch = ? AND t.status = \'Waiting\' AND (t.appointment_date = CURRENT_DATE() OR DATE(t.created_at) = CURRENT_DATE()) GROUP BY s.service_name, s.counter_number', [branch]);
    res.json({ called, waiting });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tokens/:tokenId/reschedule-request', verifyAnyUser, async (req, res) => {
  try {
    const { tokenId } = req.params;
    const { reason } = req.body;
    const [tokenRows] = await db.execute('SELECT * FROM queue_tokens WHERE token_id = ?', [tokenId]);
    if (tokenRows.length === 0) return res.status(404).json({ error: 'Token not found.' });
    const token = tokenRows[0];

    const [result] = await db.execute(
      `INSERT INTO token_reschedule_requests (token_id, user_id, patient_phone, hospital_branch, original_service_id, original_staff_id, reason, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending')`,
      [token.token_id, req.userAuth.userId || null, req.userAuth.phone || 'N/A', token.hospital_branch, token.service_id, token.staff_id, reason]
    );
    res.status(201).json({ success: true, message: `Reschedule request submitted for Token ${token.token_number}!`, requestId: result.insertId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Smart Queue Server running on http://localhost:${PORT}`);
});
