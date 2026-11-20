(function () {
    "use strict";

    const ADMINS = (window.ALERTAS_ADMIN_EMAILS || []).map(email => email.toLowerCase());
    const firebaseApp = firebase.initializeApp(window.FIREBASE_CONFIG);
    const auth = firebase.auth();
    const db = firebase.firestore();
    const publicRef = db.collection("appData").doc("public");
    const privateRef = db.collection("appData").doc("private");
    const attendanceDays = db.collection("attendanceDays");
    const ROOT_FIELDS = ["cursosPorSeccion", "students"];
    const DAILY_FIELDS = ["attendanceByDateHour", "obsByDateHourStudent", "docentesPorHora", "historialGlobal"];

    let user = null;
    let authReady;
    let currentState = null;
    let lastSavedState = null;
    let privateContacts = {};
    let lastSavedContacts = {};
    let saveQueue = Promise.resolve();
    let saveErrorShown = false;

    authReady = new Promise(resolve => {
        let unsubscribe = () => {};
        unsubscribe = auth.onAuthStateChanged(nextUser => {
            user = nextUser;
            unsubscribe();
            resolve(nextUser);
        });
    });

    function isAdmin() {
        return !!(user && user.email && user.emailVerified && ADMINS.includes(user.email.toLowerCase()));
    }

    function clone(value) {
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    function equal(left, right) {
        return JSON.stringify(left) === JSON.stringify(right);
    }

    function readLegacy(key, fallback) {
        try {
            const value = JSON.parse(localStorage.getItem(key));
            return value === null || value === undefined ? clone(fallback) : value;
        } catch (_) {
            return clone(fallback);
        }
    }

    function countAbsences(attendance, studentId) {
        let total = 0;
        Object.values(attendance || {}).forEach(hours => {
            Object.values(hours || {}).forEach(records => {
                const status = records && records[studentId];
                if (status === "Ausente" || status === "Fuga") total += 1;
            });
        });
        return total;
    }

    function publicStudents(students, attendance, adjustLegacyCounts) {
        return (students || []).map(student => {
            const base = Number.isFinite(Number(student.faltasBase))
                ? Number(student.faltasBase)
                : Math.max(0, (Number(student.faltas_acumuladas) || 0) - (adjustLegacyCounts ? countAbsences(attendance, student.id) : 0));
            return {
                id: student.id,
                nombres: String(student.nombres || ""),
                curso: String(student.curso || ""),
                jornada: student.jornada || "Matutina",
                faltasBase: base
            };
        });
    }

    function contactsById(students) {
        const contacts = {};
        (students || []).forEach(student => {
            if (student.id === undefined || student.id === null) return;
            contacts[String(student.id)] = {
                cedula: String(student.cedula || ""),
                representante: String(student.representante || ""),
                correo: String(student.correo || ""),
                telefono: String(student.telefono || "")
            };
        });
        return contacts;
    }

    function cleanPublicHistory(history, contacts) {
        const privateValues = Object.values(contacts || {}).flatMap(contact => [
            contact.cedula, contact.representante, contact.correo, contact.telefono
        ]).filter(value => typeof value === "string" && value.trim().length > 2);
        return (history || []).map(item => {
            let detail = String(item.detalle || "");
            privateValues.forEach(value => {
                detail = detail.replaceAll(value, "[dato privado]");
            });
            detail = detail
                .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[correo privado]")
                .replace(/\+?\d(?:[\s().-]*\d){8,}/g, "[teléfono privado]");
            return { ...item, detalle: detail };
        });
    }

    function contactsForHistory(nextStudents) {
        const merged = clone(privateContacts || {});
        Object.entries(contactsById(nextStudents || [])).forEach(([id, contact]) => {
            merged[id] = { ...(merged[id] || {}) };
            Object.entries(contact).forEach(([field, value]) => {
                if (value) merged[id][field] = value;
            });
        });
        return merged;
    }

    function withCalculatedAbsences(students, attendance, contacts) {
        return (students || []).map(student => {
            const contact = contacts && contacts[String(student.id)] || {};
            const faltasBase = Number(student.faltasBase) || 0;
            return {
                ...student,
                ...contact,
                faltasBase,
                faltas_acumuladas: faltasBase + countAbsences(attendance, student.id)
            };
        });
    }

    function writeCache(state) {
        localStorage.setItem("uefld_cursos_v3", JSON.stringify(state.cursosPorSeccion || { Matutina: [], Vespertina: [] }));
        const roster = (state.students || []).map(student => ({
            id: student.id,
            nombres: student.nombres,
            curso: student.curso,
            jornada: student.jornada,
            faltasBase: Number(student.faltasBase) || 0,
            faltas_acumuladas: Number(student.faltas_acumuladas) || 0
        }));
        localStorage.setItem("uefld_students_v3", JSON.stringify(roster));
        localStorage.setItem("uefld_asistencia_v3", JSON.stringify(state.attendanceByDateHour || {}));
        localStorage.setItem("uefld_obs_por_hora_v3", JSON.stringify(state.obsByDateHourStudent || {}));
        localStorage.setItem("uefld_docentes_v3", JSON.stringify(state.docentesPorHora || {}));
        localStorage.setItem("uefld_historial_v3", JSON.stringify(state.historialGlobal || []));
    }

    function stateFromDoc(data, contacts) {
        const state = {
            cursosPorSeccion: data.cursosPorSeccion || { Matutina: [], Vespertina: [] },
            students: withCalculatedAbsences(data.students || [], data.attendanceByDateHour || {}, contacts),
            attendanceByDateHour: data.attendanceByDateHour || {},
            obsByDateHourStudent: data.obsByDateHourStudent || {},
            docentesPorHora: data.docentesPorHora || {},
            historialGlobal: data.historialGlobal || []
        };
        return state;
    }

    function composeDailyData(rootData, snapshots) {
        const state = {
            cursosPorSeccion: rootData.cursosPorSeccion || { Matutina: [], Vespertina: [] },
            students: rootData.students || [],
            attendanceByDateHour: {},
            obsByDateHourStudent: {},
            docentesPorHora: {},
            historialGlobal: []
        };
        snapshots.forEach(snapshot => {
            const day = snapshot.id;
            const data = snapshot.data();
            if (data.attendance && Object.keys(data.attendance).length) state.attendanceByDateHour[day] = data.attendance;
            if (data.observations && Object.keys(data.observations).length) state.obsByDateHourStudent[day] = data.observations;
            Object.assign(state.docentesPorHora, data.teachers || {});
            state.historialGlobal.push(...(data.history || []));
        });
        state.historialGlobal.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
        return state;
    }

    function dayKeys(state) {
        const keys = new Set([
            ...Object.keys(state.attendanceByDateHour || {}),
            ...Object.keys(state.obsByDateHourStudent || {}),
            ...(state.historialGlobal || []).map(item => item.fecha || "sin-fecha")
        ]);
        Object.keys(state.docentesPorHora || {}).forEach(key => {
            const match = key.match(/^(\d{4}-\d{2}-\d{2})_/);
            if (match) keys.add(match[1]);
        });
        keys.delete("");
        return [...keys];
    }

    function dayValue(state, field, day) {
        if (field === "attendanceByDateHour") return clone((state.attendanceByDateHour || {})[day] || {});
        if (field === "obsByDateHourStudent") return clone((state.obsByDateHourStudent || {})[day] || {});
        if (field === "docentesPorHora") {
            return Object.fromEntries(Object.entries(state.docentesPorHora || {}).filter(([key]) => key.startsWith(day + "_")));
        }
        return clone((state.historialGlobal || []).filter(item => (item.fecha || "sin-fecha") === day));
    }

    function setDayValue(state, field, day, value) {
        if (field === "attendanceByDateHour" || field === "obsByDateHourStudent") {
            const target = field === "attendanceByDateHour" ? state.attendanceByDateHour : state.obsByDateHourStudent;
            if (value && Object.keys(value).length) target[day] = clone(value);
            else delete target[day];
        } else if (field === "docentesPorHora") {
            Object.keys(state.docentesPorHora || {}).filter(key => key.startsWith(day + "_")).forEach(key => delete state.docentesPorHora[key]);
            Object.assign(state.docentesPorHora, clone(value || {}));
        } else {
            state.historialGlobal = state.historialGlobal.filter(item => (item.fecha || "sin-fecha") !== day).concat(clone(value || []));
            state.historialGlobal.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
        }
    }

    async function saveDayChanges(baseState, nextState, day) {
        const ref = attendanceDays.doc(day);
        const output = await db.runTransaction(async transaction => {
            const snapshot = await transaction.get(ref);
            const latest = snapshot.exists ? snapshot.data() : {};
            const merged = {
                attendance: mergeChanges(dayValue(baseState, "attendanceByDateHour", day), dayValue(nextState, "attendanceByDateHour", day), latest.attendance || {}),
                observations: mergeChanges(dayValue(baseState, "obsByDateHourStudent", day), dayValue(nextState, "obsByDateHourStudent", day), latest.observations || {}),
                teachers: mergeChanges(dayValue(baseState, "docentesPorHora", day), dayValue(nextState, "docentesPorHora", day), latest.teachers || {}),
                history: mergeChanges(dayValue(baseState, "historialGlobal", day), dayValue(nextState, "historialGlobal", day), latest.history || [])
            };
            transaction.set(ref, { ...merged, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
            return merged;
        });
        DAILY_FIELDS.forEach(field => {
            const key = field === "attendanceByDateHour" ? "attendance"
                : field === "obsByDateHourStudent" ? "observations"
                : field === "docentesPorHora" ? "teachers" : "history";
            setDayValue(lastSavedState, field, day, output[key]);
        });
    }

    async function writeAllDays(state) {
        for (const day of dayKeys(state)) {
            const payload = {
                attendance: dayValue(state, "attendanceByDateHour", day),
                observations: dayValue(state, "obsByDateHourStudent", day),
                teachers: dayValue(state, "docentesPorHora", day),
                history: dayValue(state, "historialGlobal", day),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            };
            await attendanceDays.doc(day).set(payload);
        }
    }

    function initialState(fallback) {
        const defaults = fallback || {};
        const cursos = readLegacy("uefld_cursos_v3", defaults.cursosPorSeccion || { Matutina: [], Vespertina: [] });
        const students = readLegacy("uefld_students_v3", defaults.students || []);
        const attendance = readLegacy("uefld_asistencia_v3", defaults.attendanceByDateHour || {});
        return {
            cursosPorSeccion: cursos,
            students: publicStudents(students, attendance, true),
            attendanceByDateHour: attendance,
            obsByDateHourStudent: readLegacy("uefld_obs_por_hora_v3", defaults.obsByDateHourStudent || {}),
            docentesPorHora: readLegacy("uefld_docentes_v3", defaults.docentesPorHora || {}),
            historialGlobal: readLegacy("uefld_historial_v3", defaults.historialGlobal || [])
        };
    }

    async function loadState(fallback) {
        await authReady;
        const snapshot = await publicRef.get();
        const attendanceSnapshot = await attendanceDays.get();
        if (!snapshot.exists) {
            if (!isAdmin()) {
                throw new Error("Un administrador debe ingresar primero para preparar la base de datos compartida.");
            }
            const seed = initialState(fallback);
            const originalStudents = readLegacy("uefld_students_v3", (fallback && fallback.students) || []);
            const seedContacts = contactsById(originalStudents);
            seed.historialGlobal = cleanPublicHistory(seed.historialGlobal, seedContacts);
            await publicRef.set({
                cursosPorSeccion: seed.cursosPorSeccion,
                students: seed.students,
                schemaVersion: 1,
                initializedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            await privateRef.set({ contacts: seedContacts, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
            await writeAllDays(seed);
            privateContacts = seedContacts;
            lastSavedContacts = clone(seedContacts);
            lastSavedState = clone(seed);
            currentState = stateFromDoc(lastSavedState, seedContacts);
        } else {
            let contacts = {};
            if (isAdmin()) {
                const privateSnapshot = await privateRef.get();
                if (privateSnapshot.exists) contacts = privateSnapshot.data().contacts || {};
                else {
                    await privateRef.set({ contacts: {}, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
                }
            }
            privateContacts = contacts;
            lastSavedContacts = clone(contacts);
            lastSavedState = composeDailyData(snapshot.data(), attendanceSnapshot.docs);
            currentState = stateFromDoc(lastSavedState, contacts);
        }

        writeCache(currentState);
        window.dispatchEvent(new CustomEvent("firebase-data-ready", { detail: { admin: isAdmin(), email: user && user.email } }));
        return clone(currentState);
    }

    function mergeChanges(base, next, current) {
        if (equal(base, next)) return clone(current);
        if (Array.isArray(base) && Array.isArray(next) && Array.isArray(current)) {
            const removed = base.filter(item => !next.some(candidate => equal(candidate, item)));
            if (removed.length) return clone(next);
            const additions = next.filter(item => !base.some(candidate => equal(candidate, item)));
            const result = clone(current);
            additions.forEach(item => { if (!result.some(candidate => equal(candidate, item))) result.unshift(clone(item)); });
            return result;
        }
        if (isPlainObject(base) && isPlainObject(next) && isPlainObject(current)) {
            const result = clone(current);
            const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
            keys.forEach(key => {
                if (equal(base[key], next[key])) return;
                if (!(key in next)) delete result[key];
                else result[key] = mergeChanges(base[key], next[key], current[key]);
            });
            return result;
        }
        return clone(next);
    }

    function isPlainObject(value) {
        return !!value && typeof value === "object" && !Array.isArray(value);
    }

    function saveState(nextState, options) {
        const stateSnapshot = clone(nextState);
        const optionsSnapshot = clone(options || {});
        const task = saveQueue.then(() => saveStateNow(stateSnapshot, optionsSnapshot));
        saveQueue = task.catch(() => undefined);
        return task;
    }

    async function saveStateNow(nextState, options) {
        await authReady;
        if (!currentState || !lastSavedState) throw new Error("La base de datos aún no está lista.");
        try {
            const nextPublic = {
                cursosPorSeccion: nextState.cursosPorSeccion || currentState.cursosPorSeccion,
                students: publicStudents(nextState.students || currentState.students, nextState.attendanceByDateHour || currentState.attendanceByDateHour, false),
                attendanceByDateHour: nextState.attendanceByDateHour || currentState.attendanceByDateHour,
                obsByDateHourStudent: nextState.obsByDateHourStudent || currentState.obsByDateHourStudent,
                docentesPorHora: nextState.docentesPorHora || currentState.docentesPorHora,
                historialGlobal: cleanPublicHistory(
                    nextState.historialGlobal || currentState.historialGlobal,
                    isAdmin() ? contactsForHistory(nextState.students) : {}
                )
            };

            if (isAdmin()) {
                const rootPatch = {};
                ROOT_FIELDS.forEach(field => {
                    if (!equal(lastSavedState[field], nextPublic[field])) rootPatch[field] = clone(nextPublic[field]);
                });
                if (Object.keys(rootPatch).length) {
                    await publicRef.update(rootPatch);
                    Object.assign(lastSavedState, clone(rootPatch));
                }
            }

            const nextDays = dayKeys(nextPublic);
            const allDays = new Set([...dayKeys(lastSavedState), ...nextDays]);
            for (const day of allDays) {
                const hasChanges = DAILY_FIELDS.some(field => !equal(dayValue(lastSavedState, field, day), dayValue(nextPublic, field, day)));
                if (hasChanges) await saveDayChanges(lastSavedState, nextPublic, day);
            }

            if (isAdmin() && options && options.includeContacts && Array.isArray(nextState.students)) {
                const nextContacts = contactsById(nextState.students);
                if (!equal(lastSavedContacts, nextContacts)) {
                    await privateRef.set({ contacts: nextContacts, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
                    privateContacts = nextContacts;
                    lastSavedContacts = clone(nextContacts);
                }
            }

            currentState = stateFromDoc(lastSavedState, isAdmin() ? privateContacts : {});
            writeCache(currentState);
            window.dispatchEvent(new CustomEvent("firebase-data-updated", { detail: clone(currentState) }));
            saveErrorShown = false;
            return clone(currentState);
        } catch (error) {
            if (!saveErrorShown) {
                saveErrorShown = true;
                console.error("No se pudo sincronizar con Firebase:", error);
                alert("No se pudo guardar en Firebase. Revisa tu conexión y vuelve a intentar. Tus datos locales siguen en este dispositivo.");
            }
            throw error;
        }
    }

    function readCacheState() {
        return {
            cursosPorSeccion: readLegacy("uefld_cursos_v3", currentState && currentState.cursosPorSeccion || {}),
            students: readLegacy("uefld_students_v3", currentState && currentState.students || []),
            attendanceByDateHour: readLegacy("uefld_asistencia_v3", currentState && currentState.attendanceByDateHour || {}),
            obsByDateHourStudent: readLegacy("uefld_obs_por_hora_v3", currentState && currentState.obsByDateHourStudent || {}),
            docentesPorHora: readLegacy("uefld_docentes_v3", currentState && currentState.docentesPorHora || {}),
            historialGlobal: readLegacy("uefld_historial_v3", currentState && currentState.historialGlobal || [])
        };
    }

    async function savePatch(patch) {
        return saveState({ ...readCacheState(), ...patch });
    }

    async function importBackup(backup) {
        await authReady;
        if (!isAdmin()) throw new Error("Solo los administradores autorizados pueden recuperar respaldos.");
        if (!backup || typeof backup !== "object") throw new Error("El archivo no contiene un respaldo válido.");
        const courses = backup.cursosPorSeccion || backup.courses;
        const sourceStudents = backup.students || backup.estudiantes;
        if (!courses || !Array.isArray(sourceStudents)) throw new Error("El respaldo debe incluir cursos y una lista de estudiantes.");
        const attendance = backup.attendanceByDateHour || backup.asistencia || {};
        const state = {
            cursosPorSeccion: courses,
            students: publicStudents(sourceStudents, attendance, true),
            attendanceByDateHour: attendance,
            obsByDateHourStudent: backup.obsByDateHourStudent || backup.observaciones || {},
            docentesPorHora: backup.docentesPorHora || backup.docentes || {},
            historialGlobal: backup.historialGlobal || backup.historial || []
        };
        const contacts = contactsById(sourceStudents);
        state.historialGlobal = cleanPublicHistory(state.historialGlobal, contacts);
        await publicRef.set({
            cursosPorSeccion: state.cursosPorSeccion,
            students: state.students,
            schemaVersion: 1,
            initializedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        await privateRef.set({ contacts, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        const retainedDays = new Set(dayKeys(state));
        const existingDays = await attendanceDays.get();
        for (const dayDoc of existingDays.docs) {
            if (!retainedDays.has(dayDoc.id)) await dayDoc.ref.delete();
        }
        await writeAllDays(state);
        privateContacts = contacts;
        lastSavedContacts = clone(contacts);
        lastSavedState = clone(state);
        currentState = stateFromDoc(state, contacts);
        writeCache(currentState);
        window.dispatchEvent(new CustomEvent("firebase-data-updated", { detail: clone(currentState) }));
        return clone(currentState);
    }

    async function signInAdmin() {
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        const result = await auth.signInWithPopup(provider);
        user = result.user;
        if (!isAdmin()) {
            await auth.signOut();
            user = null;
            throw new Error("Esta cuenta no tiene permiso para modificar la aplicación.");
        }
        return result.user;
    }

    async function signOut() {
        await auth.signOut();
        user = null;
    }

    window.AlertasFirebase = {
        app: firebaseApp,
        auth,
        db,
        admins: ADMINS,
        isAdmin,
        getUser: () => user,
        ready: () => authReady,
        signInAdmin,
        signOut,
        loadState,
        saveState,
        savePatch,
        importBackup,
        countAbsences,
        getCurrentState: () => clone(currentState)
    };
})();
