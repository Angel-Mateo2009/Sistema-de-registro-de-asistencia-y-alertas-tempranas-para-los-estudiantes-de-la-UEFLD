// ================= IMPORTACIÓN MASIVA DEPURADA POR CURSO (EXCEL / CSV) =================
        let cursoDestinoImportacion = '';

        function abrirSelectorImportacion() {
            const cursos = cursosPorSeccion[jornadaActual] || [];
            if (cursos.length === 0) {
                alert(`Primero debes crear al menos un curso en la sección ${jornadaActual}.`);
                abrirModalCrearCurso();
                return;
            }

            if (cursoSeleccionado) {
                cursoDestinoImportacion = cursoSeleccionado;
                document.getElementById('import-excel-input').click();
                return;
            }

            const elegida = prompt(
                `No tienes una tarjeta de curso seleccionada.\nEscribe el número del curso destino (${jornadaActual}):\n\n` +
                cursos.map((c, i) => `${i + 1}. ${c}`).join('\n')
            );
            if (!elegida) return;

            const idx = Number(elegida.trim()) - 1;
            if (!Number.isInteger(idx) || idx < 0 || idx >= cursos.length) {
                alert('Número de curso no válido.');
                return;
            }

            cursoDestinoImportacion = cursos[idx];
            document.getElementById('import-excel-input').click();
        }

        function normalizarClaveColumna(clave) {
            return String(clave || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-z0-9]/g, '');
        }

        function extraerCampoFila(filaNorm, posiblesClaves) {
            for (const k of posiblesClaves) {
                if (filaNorm[k] !== undefined && filaNorm[k] !== null && String(filaNorm[k]).trim() !== '') {
                    return String(filaNorm[k]).trim();
                }
            }
            return '';
        }

        async function importarEstudiantesArchivo(event) {
            const file = event.target.files && event.target.files[0];
            event.target.value = '';
            if (!file || !cursoDestinoImportacion) return;

            if (typeof XLSX === 'undefined') {
                alert('No se pudo cargar el lector de Excel/CSV. Verifica tu conexión a internet.');
                return;
            }

            try {
                const buffer = await file.arrayBuffer();
                const workbook = XLSX.read(buffer, { type: 'array' });
                const primeraHoja = workbook.SheetNames[0];
                const filasCrud = XLSX.utils.sheet_to_json(workbook.Sheets[primeraHoja], { defval: '' });

                if (!Array.isArray(filasCrud) || filasCrud.length === 0) {
                    alert('El archivo está vacío o no tiene filas válidas.');
                    return;
                }

                const cedulasVistas = new Set(
                    students
                        .filter(s => (s.jornada || 'Matutina') === jornadaActual && s.curso === cursoDestinoImportacion)
                        .map(s => String(s.cedula || '').trim())
                        .filter(Boolean)
                );
                const nombresVistos = new Set(
                    students
                        .filter(s => (s.jornada || 'Matutina') === jornadaActual && s.curso === cursoDestinoImportacion)
                        .map(s => String(s.nombres || '').trim().toUpperCase())
                        .filter(Boolean)
                );

                const nuevosDepurados = [];
                let omitidos = 0;
                const baseId = Date.now();

                filasCrud.forEach((rawFila, i) => {
                    const filaNorm = {};
                    Object.keys(rawFila).forEach(col => {
                        filaNorm[normalizarClaveColumna(col)] = rawFila[col];
                    });

                    const nombres = extraerCampoFila(filaNorm, [
                        'nombres', 'apellidosynombres', 'estudiante', 'alumno', 'nombre', 'apellidos', 'student'
                    ]).replace(/\s+/g, ' ').toUpperCase();

                    if (!nombres) {
                        omitidos++;
                        return;
                    }

                    const cedula = extraerCampoFila(filaNorm, [
                        'cedula', 'ci', 'dni', 'identificacion', 'id'
                    ]).replace(/\s+/g, '');

                    const representante = extraerCampoFila(filaNorm, [
                        'representante', 'apoderado', 'padre', 'madre', 'tutor'
                    ]).replace(/\s+/g, ' ');

                    const telefono = extraerCampoFila(filaNorm, [
                        'telefono', 'celular', 'movil', 'whatsapp', 'fono', 'tel'
                    ]).replace(/\s+/g, '');

                    const correo = extraerCampoFila(filaNorm, [
                        'correo', 'correoelectronico', 'email', 'mail', 'correorepresentante'
                    ]).replace(/\s+/g, '').toLowerCase();

                    const faltasRaw = parseInt(extraerCampoFila(filaNorm, ['faltas', 'faltasacumuladas', 'inasistencias']), 10);
                    const faltas_acumuladas = Number.isNaN(faltasRaw) ? 0 : Math.max(0, faltasRaw);

                    if ((cedula && cedulasVistas.has(cedula)) || nombresVistos.has(nombres)) {
                        omitidos++;
                        return;
                    }

                    if (cedula) cedulasVistas.add(cedula);
                    nombresVistos.add(nombres);

                    nuevosDepurados.push({
                        id: baseId + i + Math.floor(Math.random() * 1000),
                        cedula: cedula || `S-C-${baseId.toString().slice(-4)}${i + 1}`,
                        nombres,
                        curso: cursoDestinoImportacion,
                        jornada: jornadaActual,
                        representante: representante || 'No registrado',
                        correo: correo || '',
                        telefono: telefono || '',
                        faltas_acumuladas
                    });
                });

                if (nuevosDepurados.length === 0) {
                    alert(`No se agregaron estudiantes nuevos en "${cursoDestinoImportacion}" (posibles filas vacías o duplicadas).`);
                    return;
                }

                students = [...students, ...nuevosDepurados];
                cursoSeleccionado = cursoDestinoImportacion;
                const idxCurso = (cursosPorSeccion[jornadaActual] || []).indexOf(cursoSeleccionado);
                document.getElementById('course-filter').value = idxCurso >= 0 ? String(idxCurso) : '';

                guardarTodoStorage();
                renderAll();

                alert(
                    `✅ Importación completada en "${cursoDestinoImportacion}" (${jornadaActual}):\n` +
                    `• ${nuevosDepurados.length} estudiante(s) depurado(s) y cargado(s).\n` +
                    `• ${omitidos} fila(s) omitida(s) por estar vacías o duplicadas.`
                );
            } catch (err) {
                alert('Error al leer el archivo. Verifica que sea un .csv, .xlsx o .xls válido.');
            } finally {
                cursoDestinoImportacion = '';
            }
        }