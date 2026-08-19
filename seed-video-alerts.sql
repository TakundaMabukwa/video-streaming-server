INSERT INTO alert_definitions (name, category, signal_code, severity, description, is_active) VALUES
('Fatigue Alarm', 'video', 'fatigueAlarm', 'CRITICAL', 'Driver fatigue detected - alarm level', true),
('Crash', 'video', 'bang', 'CRITICAL', 'Vehicle crash/impact detected', true),
('Forward Collision', 'video', 'forwardCollisionWarning', 'CRITICAL', 'Forward collision warning triggered', true),
('Pedestrian Collision', 'video', 'pedestrianBang', 'CRITICAL', 'Pedestrian collision detected', true),
('Camera Occlusion', 'video', 'occlusion', 'CRITICAL', 'Camera blocked or tampered', true),
('Panic Alert', 'video', 'sos', 'CRITICAL', 'SOS panic button pressed', true),
('Fatigue Warning', 'video', 'fatigueWarn', 'HIGH', 'Driver fatigue warning - early stage', true),
('Cellphone Use', 'video', 'handheldPhoneCall', 'HIGH', 'Driver using handheld phone', true),
('Tailgating', 'video', 'closeProximity', 'HIGH', 'Following too close to vehicle ahead', true),
('Rollover', 'video', 'hardBraking', 'HIGH', 'Hard braking or rollover detected', true),
('Overspeeding', 'video', 'speed', 'HIGH', 'Vehicle exceeding speed limit', true),
('Seatbelt Violation', 'video', 'seatBelt', 'MEDIUM', 'Driver not wearing seatbelt', true),
('Lane Deviation', 'video', 'laneShift', 'MEDIUM', 'Vehicle drifting out of lane', true),
('Driver Not Detected', 'video', 'driverNotDetected', 'MEDIUM', 'Driver not visible in camera view', true),
('Battery Disconnection', 'video', 'powerCut', 'MEDIUM', 'Device power disconnected', true),
('Overtime Driving', 'video', 'overtime', 'LOW', 'Driving longer than 3 hours continuous', true)
ON CONFLICT (signal_code) DO NOTHING;
