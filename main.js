const fs = require("fs");
console.log("main.js loaded");

// ============ INTERNAL HELPER FUNCTIONS (not exported) ============

/**
 * Converts a time string to total seconds since midnight.
 * Accepts "h:mm:ss am/pm" (12-hour clock) or "h:mm:ss" / "hhh:mm:ss" (duration).
 * Handles 12:xx:xx AM = 0 hours, 12:xx:xx PM = 12 hours.
 */
function timeToSeconds(timeStr) {
    timeStr = timeStr.trim();
    let parts = timeStr.split(/\s+/);
    let timePart = parts[0];
    let period = parts.length > 1 ? parts[1].toLowerCase() : null;

    let segments = timePart.split(":");
    let h = Number(segments[0]);
    let m = Number(segments[1]);
    let s = Number(segments[2]);

    if (period) {
        if (period === "am") {
            if (h === 12) h = 0;
        } else if (period === "pm") {
            if (h !== 12) h += 12;
        }
    }

    return h * 3600 + m * 60 + s;
}

/**
 * Converts total seconds to a time/duration string.
 * Format: h:mm:ss (hours are NOT zero-padded; minutes and seconds ARE).
 * Supports arbitrarily large hour values for monthly aggregations.
 */
function secondsToTime(totalSeconds) {
    if (totalSeconds < 0) totalSeconds = 0;
    let h = Math.floor(totalSeconds / 3600);
    let remainder = totalSeconds % 3600;
    let m = Math.floor(remainder / 60);
    let s = remainder % 60;
    return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

/**
 * Returns the weekday name (e.g. "Friday") for a yyyy-mm-dd date string.
 */
function parseDateToDay(dateStr) {
    let parts = dateStr.trim().split("-");
    let y = Number(parts[0]);
    let m = Number(parts[1]);
    let d = Number(parts[2]);
    let date = new Date(y, m - 1, d);
    var days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return days[date.getDay()];
}

/**
 * Returns true if the date falls in the Eid al-Fitr period (Apr 10–30, 2025 inclusive).
 */
function isEidPeriod(dateStr) {
    let parts = dateStr.trim().split("-");
    let y = Number(parts[0]);
    let m = Number(parts[1]);
    let d = Number(parts[2]);
    return y === 2025 && m === 4 && d >= 10 && d <= 30;
}

/**
 * Reads a text file and returns an array of non-empty, trimmed lines.
 * Handles \r\n, \r, missing trailing newlines, and stray blank rows.
 */
function readFileLines(filePath) {
    let content = fs.readFileSync(filePath, { encoding: "utf8" });
    let lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    // Remove trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
        lines.pop();
    }
    return lines;
}

/**
 * Writes an array of lines back to a file, joined by \n with a trailing newline.
 */
function writeFileLines(filePath, lines) {
    fs.writeFileSync(filePath, lines.join("\n") + "\n", { encoding: "utf8" });
}

/**
 * Parses a single comma-separated shift data line into an object.
 * Returns null for lines with fewer than 10 fields.
 */
function parseShiftLine(line) {
    let parts = line.split(",");
    if (parts.length < 10) return null;
    return {
        driverID: parts[0].trim(),
        driverName: parts[1].trim(),
        date: parts[2].trim(),
        startTime: parts[3].trim(),
        endTime: parts[4].trim(),
        shiftDuration: parts[5].trim(),
        idleTime: parts[6].trim(),
        activeTime: parts[7].trim(),
        metQuota: parts[8].trim() === "true",
        hasBonus: parts[9].trim() === "true"
    };
}

/**
 * Converts a shift object back into a comma-separated text line.
 */
function shiftObjToLine(obj) {
    return [
        obj.driverID,
        obj.driverName,
        obj.date,
        obj.startTime,
        obj.endTime,
        obj.shiftDuration,
        obj.idleTime,
        obj.activeTime,
        obj.metQuota,
        obj.hasBonus
    ].join(",");
}

/**
 * Parses the driver rates file into a lookup object keyed by driverID.
 * Each value: { driverID, dayOff, basePay, tier }.
 */
function parseRateFile(rateFile) {
    let lines = readFileLines(rateFile);
    let rates = {};
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (line === "") continue;
        let parts = line.split(",");
        if (parts.length < 4) continue;
        let id = parts[0].trim();
        // Skip header row if present
        if (id.toLowerCase() === "driverid" || id === "") continue;
        rates[id] = {
            driverID: id,
            dayOff: parts[1].trim(),
            basePay: parseInt(parts[2].trim()),
            tier: parseInt(parts[3].trim())
        };
    }
    return rates;
}

/**
 * Computes how many seconds of a segment [segStart, segEnd] overlap
 * with the delivery window [8:00 AM, 10:00 PM] = [28800, 79200].
 */
function computeActiveOverlap(segStart, segEnd) {
    if (segStart >= segEnd) return 0;
    let overlapStart = Math.max(segStart, 28800);
    let overlapEnd = Math.min(segEnd, 79200);
    return Math.max(0, overlapEnd - overlapStart);
}

// ============================================================
// Function 1: getShiftDuration(startTime, endTime)
// startTime: (typeof string) formatted as hh:mm:ss am or hh:mm:ss pm
// endTime: (typeof string) formatted as hh:mm:ss am or hh:mm:ss pm
// Returns: string formatted as h:mm:ss
// ============================================================
function getShiftDuration(startTime, endTime) {
    let startSec = timeToSeconds(startTime);
    let endSec = timeToSeconds(endTime);

    let duration;
    if (endSec >= startSec) {
        duration = endSec - startSec;
    } else {
        // Overnight shift
        duration = (86400 - startSec) + endSec;
    }

    return secondsToTime(duration);
}

// ============================================================
// Function 2: getIdleTime(startTime, endTime)
// startTime: (typeof string) formatted as hh:mm:ss am or hh:mm:ss pm
// endTime: (typeof string) formatted as hh:mm:ss am or hh:mm:ss pm
// Returns: string formatted as h:mm:ss
// ============================================================
function getIdleTime(startTime, endTime) {
    let startSec = timeToSeconds(startTime);
    let endSec = timeToSeconds(endTime);

    let totalDuration;
    let activeOverlap;

    if (endSec >= startSec) {
        // Same-day shift
        totalDuration = endSec - startSec;
        activeOverlap = computeActiveOverlap(startSec, endSec);
    } else {
        // Overnight shift: split into two segments
        totalDuration = (86400 - startSec) + endSec;
        activeOverlap = computeActiveOverlap(startSec, 86400) + computeActiveOverlap(0, endSec);
    }

    let idleSec = totalDuration - activeOverlap;
    return secondsToTime(idleSec);
}

// ============================================================
// Function 3: getActiveTime(shiftDuration, idleTime)
// shiftDuration: (typeof string) formatted as h:mm:ss
// idleTime: (typeof string) formatted as h:mm:ss
// Returns: string formatted as h:mm:ss
// ============================================================
function getActiveTime(shiftDuration, idleTime) {
    let durationSec = timeToSeconds(shiftDuration);
    let idleSec = timeToSeconds(idleTime);
    let activeSec = durationSec - idleSec;
    if (activeSec < 0) activeSec = 0;
    return secondsToTime(activeSec);
}

// ============================================================
// Function 4: metQuota(date, activeTime)
// date: (typeof string) formatted as yyyy-mm-dd
// activeTime: (typeof string) formatted as h:mm:ss
// Returns: boolean
// ============================================================
function metQuota(date, activeTime) {
    let activeSec = timeToSeconds(activeTime);
    let quotaSec;

    if (isEidPeriod(date)) {
        quotaSec = 6 * 3600; // 6 hours
    } else {
        quotaSec = 8 * 3600 + 24 * 60; // 8 hours 24 minutes = 30240 seconds
    }

    return activeSec >= quotaSec;
}

// ============================================================
// Function 5: addShiftRecord(textFile, shiftObj)
// textFile: (typeof string) path to shifts text file
// shiftObj: (typeof object) has driverID, driverName, date, startTime, endTime
// Returns: object with 10 properties or empty object {}
// ============================================================
function addShiftRecord(textFile, shiftObj) {
    let lines = readFileLines(textFile);

    // Check for duplicate (same driverID AND date)
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (line === "" || line.toLowerCase().startsWith("driverid")) continue;
        let parsed = parseShiftLine(line);
        if (parsed && parsed.driverID === shiftObj.driverID && parsed.date === shiftObj.date) {
            return {};
        }
    }

    // Calculate all derived fields
    let duration = getShiftDuration(shiftObj.startTime, shiftObj.endTime);
    let idle = getIdleTime(shiftObj.startTime, shiftObj.endTime);
    let active = getActiveTime(duration, idle);
    let quota = metQuota(shiftObj.date, active);

    let newRecord = {
        driverID: shiftObj.driverID,
        driverName: shiftObj.driverName,
        date: shiftObj.date,
        startTime: shiftObj.startTime,
        endTime: shiftObj.endTime,
        shiftDuration: duration,
        idleTime: idle,
        activeTime: active,
        metQuota: quota,
        hasBonus: false
    };

    let newLine = shiftObjToLine(newRecord);

    // Find the last occurrence of this driverID
    let lastIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (line === "" || line.toLowerCase().startsWith("driverid")) continue;
        let parsed = parseShiftLine(line);
        if (parsed && parsed.driverID === shiftObj.driverID) {
            lastIndex = i;
        }
    }

    if (lastIndex >= 0) {
        // Insert right after the last record of this driver
        lines.splice(lastIndex + 1, 0, newLine);
    } else {
        // Driver not in file – append as last record
        lines.push(newLine);
    }

    writeFileLines(textFile, lines);
    return newRecord;
}

// ============================================================
// Function 6: setBonus(textFile, driverID, date, newValue)
// textFile: (typeof string) path to shifts text file
// driverID: (typeof string)
// date: (typeof string) formatted as yyyy-mm-dd
// newValue: (typeof boolean)
// Returns: nothing (void)
// ============================================================
function setBonus(textFile, driverID, date, newValue) {
    let lines = readFileLines(textFile);

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (line === "" || line.toLowerCase().startsWith("driverid")) continue;
        let parsed = parseShiftLine(line);
        if (parsed && parsed.driverID === driverID && parsed.date === date) {
            parsed.hasBonus = newValue;
            lines[i] = shiftObjToLine(parsed);
            break;
        }
    }

    writeFileLines(textFile, lines);
}

// ============================================================
// Function 7: countBonusPerMonth(textFile, driverID, month)
// textFile: (typeof string) path to shifts text file
// driverID: (typeof string)
// month: (typeof string) formatted as mm or m
// Returns: number (-1 if driverID not found)
// ============================================================
function countBonusPerMonth(textFile, driverID, month) {
    let lines = readFileLines(textFile);
    let monthNum = parseInt(month);

    let driverFound = false;
    let count = 0;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (line === "" || line.toLowerCase().startsWith("driverid")) continue;
        let parsed = parseShiftLine(line);
        if (!parsed) continue;
        if (parsed.driverID === driverID) {
            driverFound = true;
            let dateParts = parsed.date.split("-");
            let m = Number(dateParts[1]);
            if (m === monthNum && parsed.hasBonus === true) {
                count++;
            }
        }
    }

    if (!driverFound) return -1;
    return count;
}

// ============================================================
// Function 8: getTotalActiveHoursPerMonth(textFile, driverID, month)
// textFile: (typeof string) path to shifts text file
// driverID: (typeof string)
// month: (typeof number)
// Returns: string formatted as hhh:mm:ss
// ============================================================
function getTotalActiveHoursPerMonth(textFile, driverID, month) {
    let lines = readFileLines(textFile);
    let monthNum = typeof month === "number" ? month : parseInt(month);

    let totalSec = 0;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (line === "" || line.toLowerCase().startsWith("driverid")) continue;
        let parsed = parseShiftLine(line);
        if (!parsed) continue;
        if (parsed.driverID === driverID) {
            let dateParts = parsed.date.split("-");
            let m = Number(dateParts[1]);
            if (m === monthNum) {
                totalSec += timeToSeconds(parsed.activeTime);
            }
        }
    }

    return secondsToTime(totalSec);
}

// ============================================================
// Function 9: getRequiredHoursPerMonth(textFile, rateFile, bonusCount, driverID, month)
// textFile: (typeof string) path to shifts text file
// rateFile: (typeof string) path to driver rates text file
// bonusCount: (typeof number) total bonuses for given driver per month
// driverID: (typeof string)
// month: (typeof number)
// Returns: string formatted as hhh:mm:ss
// ============================================================
function getRequiredHoursPerMonth(textFile, rateFile, bonusCount, driverID, month) {
    let lines = readFileLines(textFile);
    let rates = parseRateFile(rateFile);
    let monthNum = typeof month === "number" ? month : parseInt(month);

    let driverRate = rates[driverID];
    if (!driverRate) return secondsToTime(0);

    let dayOff = driverRate.dayOff;
    let totalRequiredSec = 0;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (line === "" || line.toLowerCase().startsWith("driverid")) continue;
        let parsed = parseShiftLine(line);
        if (!parsed) continue;
        if (parsed.driverID !== driverID) continue;

        let dateParts = parsed.date.split("-");
        let m = Number(dateParts[1]);
        if (m !== monthNum) continue;

        // Skip if this date is the driver's assigned day off
        let weekday = parseDateToDay(parsed.date);
        if (weekday === dayOff) continue;

        // Eid period: 6-hour quota. Otherwise: 8h 24m quota.
        if (isEidPeriod(parsed.date)) {
            totalRequiredSec += 6 * 3600;
        } else {
            totalRequiredSec += 8 * 3600 + 24 * 60;
        }
    }

    // Subtract 2 hours for each bonus
    totalRequiredSec -= bonusCount * 2 * 3600;
    if (totalRequiredSec < 0) totalRequiredSec = 0;

    return secondsToTime(totalRequiredSec);
}

// ============================================================
// Function 10: getNetPay(driverID, actualHours, requiredHours, rateFile)
// driverID: (typeof string)
// actualHours: (typeof string) formatted as hhh:mm:ss
// requiredHours: (typeof string) formatted as hhh:mm:ss
// rateFile: (typeof string) path to driver rates text file
// Returns: integer (net pay)
// ============================================================
function getNetPay(driverID, actualHours, requiredHours, rateFile) {
    let rates = parseRateFile(rateFile);
    let driverRate = rates[driverID];
    if (!driverRate) return 0;

    let basePay = driverRate.basePay;
    let tier = driverRate.tier;

    let tierAllowances = { 1: 50, 2: 20, 3: 10, 4: 3 };
    let allowance = tierAllowances[tier] || 0;

    let actualSec = timeToSeconds(actualHours);
    let requiredSec = timeToSeconds(requiredHours);

    // No deduction if actual meets or exceeds required
    if (actualSec >= requiredSec) return basePay;

    let missingSec = requiredSec - actualSec;
    let missingHours = missingSec / 3600;

    // Subtract the tier allowance
    let billableHours = missingHours - allowance;
    if (billableHours <= 0) return basePay;

    // Only full hours count
    billableHours = Math.floor(billableHours);

    let deductionRatePerHour = Math.floor(basePay / 185);
    let deduction = billableHours * deductionRatePerHour;

    return basePay - deduction;
}

module.exports = {
    getShiftDuration,
    getIdleTime,
    getActiveTime,
    metQuota,
    addShiftRecord,
    setBonus,
    countBonusPerMonth,
    getTotalActiveHoursPerMonth,
    getRequiredHoursPerMonth,
    getNetPay
};
