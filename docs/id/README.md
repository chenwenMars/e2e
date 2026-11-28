# Dokumentasi Bahasa Indonesia

Terjemahan Bahasa Indonesia untuk dokumentasi e2e. Halaman berbahasa Indonesia
tersedia di `/docs/id/<path>`, misalnya `/docs/id/quickstart`. Jika terjemahan
belum tersedia, situs menampilkan halaman bahasa Inggris dengan pemberitahuan.
Bahasa Inggris tetap menjadi sumber utama.

Terjemahan ini bersifat bertahap. Halaman bahasa Inggris dapat berubah lebih
dulu, sehingga terjemahan bisa tertinggal sampai diperbarui. `pnpm docs:check`
menampilkan halaman dan label yang perlu diselaraskan.

## Struktur

- `docs/id/<path>.mdx` menerjemahkan `docs/<path>.mdx` dengan jalur dan nama
  file yang sama.
- `docs/docs.json` menentukan urutan navigasi dan halaman. Jangan mengubah file
  ini untuk menambahkan bahasa.
- `navigation.json` berisi terjemahan label setiap tab dan grup, dengan label
  bahasa Inggris sebagai kuncinya. Urutan navigasi mengikuti `docs/docs.json`.
- Gambar, snippet, dan contoh di `docs/examples/` digunakan bersama oleh semua
  bahasa.

## Memperbarui terjemahan

1. Terjemahkan teks yang dibaca pengguna: isi halaman, judul, deskripsi,
   `sidebarTitle`, serta atribut yang tampil seperti `title` pada `<Card>`,
   `<Accordion>`, `<Tab>`, dan `<Step>`, juga isi `<Note>`, `<Warning>`, dan
   `<Tip>`.
2. Pertahankan struktur halaman: heading dengan level, urutan, dan jumlah yang
   sama; elemen `<Tab>` dan `<Accordion>` dalam urutan yang sama; serta setiap
   `id="..."`. Situs mencocokkan ID heading terjemahan dengan halaman Inggris
   berdasarkan posisinya agar tautan bagian tetap berfungsi.
3. Jangan ubah blok kode, kode inline, judul fence, URL, target tautan, maupun
   anchor `#...`. Tautan internal tetap relatif terhadap docs, misalnya
   `/quickstart#install`. Situs akan mengarahkannya ke halaman Bahasa Indonesia.
4. Jalur impor snippet berada satu tingkat lebih dalam pada terjemahan. Ubah
   `./snippets/x.jsx` menjadi `../snippets/x.jsx`.

## Gaya

- Gunakan Bahasa Indonesia baku yang ringkas, jelas, dan langsung. Sapa pembaca
  dengan “Anda” bila perlu; utamakan kalimat aktif dan instruksi langsung.
- Pertahankan nama produk, nama paket, API, perintah, opsi CLI, dan identifier
  dalam bahasa Inggris, termasuk e2e, Playwright, `@e2e-dev/web`, MCP, CI,
  GitHub Actions, `test()`, dan `agent.act`.
- Gunakan istilah pada glosarium secara konsisten. Istilah yang merupakan nama
  API tetap ditulis persis seperti di kode.

| English | Bahasa Indonesia |
| --- | --- |
| framework | kerangka kerja |
| project | proyek |
| package | paket |
| run | eksekusi (`e2e run` tetap ditulis seperti perintahnya) |
| path | jalur |
| test, test suite | tes, rangkaian tes |
| agent, agentic | agent, berbasis agent |
| deterministic | deterministik |
| engine | engine |
| runner | runner |
| fixture | fixture |
| locator | locator |
| step | langkah |
| goal, atomic goal | tujuan, tujuan atomik |
| assertion | assertion |
| target | target |
| replay cache | cache replay |
| executor | executor |
| tool | tool |
| provider | provider |
| hosted browser | browser cloud |
| device | perangkat |
| worker | worker |
| retry | percobaan ulang |
| report, reporter | laporan, reporter |
| secret | secret |
| session | sesi |
| judge | menilai |
| decision model | model keputusan |
| coding agent | coding agent |
| skill | skill |
| bug bash | bug bash |
| visual testing | pengujian visual |
| self-healing | perbaikan otomatis |
| pull request | pull request |
| config, configuration | konfigurasi |
| screenshot | screenshot |
| semantic tree | pohon semantik |
| timeout | batas waktu |
| sign in, sign out | masuk, keluar |
| subscription | langganan |
| prompt | prompt |
| API key | API key |
| authentication | autentikasi |
| end-to-end testing | pengujian end-to-end |
| web, mobile | web, mobile |
| continuous integration | continuous integration (CI) |
