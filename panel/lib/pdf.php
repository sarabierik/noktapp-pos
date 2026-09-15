<?php
/**
 * A very small PDF writer, in plain PHP.
 *
 * The till has a report PDF builder already (pos-service/src/report/pdf.js)
 * and this file follows its conventions deliberately - the same legal header,
 * the same orange rule, the same "what is NOT in these figures" note, the same
 * Sayfa n / m - so the two look like one product. It does not, and cannot,
 * call across: that is Node with PDFKit on a restaurant's PC, this is PHP on
 * shared hosting where installing a library is not something we can ask a
 * customer to do. So it is written out by hand, and kept small enough to read.
 *
 * The font trap, which has bitten this codebase before:
 *
 *   The 14 built-in PDF fonts are WinAnsi. Helvetica has ç ö ü Ç Ö Ü but no
 *   ğ ş ı İ Ğ Ş at all, and asking for one writes its raw UTF-8 bytes onto the
 *   page as mojibake. Embedding a Unicode TTF would mean shipping a font file
 *   with the panel. So every string on the page goes through ascii() and the
 *   text stays Turkish, it just loses its dots - exactly as the printed hesap
 *   fisi has always done.
 */

class NpPdf {
    const ORANGE = '#FF7A1A';
    const W = 842.0;          // A4 landscape: a fifteen-column table does not
    const H = 595.0;          // fit on a portrait page and must not be shrunk
    const MARGIN = 32.0;

    private array $pages = [];      // finished content streams
    private string $buf = '';       // the page being drawn
    public float $y = self::MARGIN; // cursor, measured DOWN from the top
    private $header = null;
    private bool $inHeader = false;

    public function right(): float { return self::W - self::MARGIN; }
    public function bottom(): float { return self::H - 42.0; }   // the footer band is not ours

    /** Drawn at the top of every page: the taxpayer block and the title. */
    public function onNewPage(callable $fn): void { $this->header = $fn; }

    public function addPage(): void {
        if ($this->buf !== '') $this->pages[] = $this->buf;
        $this->buf = '';
        $this->y = self::MARGIN;
        if ($this->header && !$this->inHeader) {
            $this->inHeader = true;
            ($this->header)($this);
            $this->inHeader = false;
        }
    }

    /** Make room for `n` points, starting a new page if there is not any. */
    public function need(float $n): void { if ($this->y + $n > $this->bottom()) $this->addPage(); }
    public function gap(float $n): void { $this->y += $n; }

    /* ------------------------------- text ------------------------------- */

    private const FOLD = [
        'ç'=>'c','Ç'=>'C','ğ'=>'g','Ğ'=>'G','ı'=>'i','İ'=>'I','ö'=>'o','Ö'=>'O',
        'ş'=>'s','Ş'=>'S','ü'=>'u','Ü'=>'U','â'=>'a','Â'=>'A','î'=>'i','û'=>'u',
        '₺'=>'TL','–'=>'-','—'=>'-','·'=>'-','’'=>"'",'“'=>'"','”'=>'"','…'=>'...',
    ];
    public static function ascii($v): string {
        $s = (string) ($v ?? '');
        $s = strtr($s, self::FOLD);
        return preg_replace('/[^\x20-\x7E]/u', '', $s) ?? '';
    }

    /* Helvetica's own metrics, so a right-aligned column of money actually
       lines up. Guessing an average character width puts the last digit of
       "1.234.567,89" a couple of points off, and a column of figures that does
       not align is a column an accountant re-types. */
    private const WIDTH_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
        556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,
        667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,
        278,278,278,469,556,333,
        556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,
        334,260,334,584];
    private const WIDTH_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
        556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,
        722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,
        333,278,333,584,556,333,
        556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,
        389,280,389,584];

    public static function widthOf(string $ascii, float $size, bool $bold): float {
        $tab = $bold ? self::WIDTH_BOLD : self::WIDTH_REG;
        $w = 0;
        $len = strlen($ascii);
        for ($i = 0; $i < $len; $i++) {
            $c = ord($ascii[$i]) - 32;
            $w += ($c >= 0 && $c < count($tab)) ? $tab[$c] : 500;
        }
        return $w * $size / 1000.0;
    }

    /** Cut a string to fit a column rather than letting it run into the next. */
    public static function fit(string $ascii, float $max, float $size, bool $bold): string {
        if (self::widthOf($ascii, $size, $bold) <= $max) return $ascii;
        while ($ascii !== '' && self::widthOf($ascii . '..', $size, $bold) > $max) $ascii = substr($ascii, 0, -1);
        return $ascii . '..';
    }

    private static function esc(string $s): string {
        return str_replace(['\\', '(', ')'], ['\\\\', '\\(', '\\)'], $s);
    }
    private static function rgb(string $hex): string {
        $hex = ltrim($hex, '#');
        if (strlen($hex) === 3) $hex = $hex[0].$hex[0].$hex[1].$hex[1].$hex[2].$hex[2];
        return sprintf('%.3f %.3f %.3f', hexdec(substr($hex,0,2))/255, hexdec(substr($hex,2,2))/255, hexdec(substr($hex,4,2))/255);
    }

    /** One line of text at the cursor, advancing it. */
    public function text($s, float $size = 9, bool $bold = false, string $color = '#111'): void {
        $this->need($size + 4);
        $this->draw(self::ascii($s), self::MARGIN, $this->y + $size, $size, $bold, $color);
        $this->y += $size + 4;
    }

    /** One cell at an absolute x, not advancing the cursor. */
    public function cell($s, float $x, float $w, float $size, bool $bold, string $color, string $align = 'left'): void {
        $a = self::fit(self::ascii($s), $w, $size, $bold);
        if ($align === 'right') $x = $x + $w - self::widthOf($a, $size, $bold);
        $this->draw($a, $x, $this->y + $size, $size, $bold, $color);
    }

    private function draw(string $ascii, float $x, float $yFromTop, float $size, bool $bold, string $color): void {
        if ($ascii === '') return;
        $this->buf .= sprintf("BT /%s %.2f Tf %s rg %.2f %.2f Td (%s) Tj ET\n",
            $bold ? 'F2' : 'F1', $size, self::rgb($color), $x, self::H - $yFromTop, self::esc($ascii));
    }

    public function rule(string $color = '#ddd', float $w = 0.5): void {
        $this->buf .= sprintf("%s RG %.2f w %.2f %.2f m %.2f %.2f l S\n",
            self::rgb($color), $w, self::MARGIN, self::H - $this->y, $this->right(), self::H - $this->y);
    }

    /* ------------------------------ blocks ------------------------------ */

    /** A wrapped paragraph list - the status lines and the scope note. */
    public function block(string $title, array $lines): void {
        $this->need(30 + count($lines) * 12);
        $this->text($title, 10, true);
        $this->rule(self::ORANGE, 1.2);
        $this->gap(6);
        $wide = $this->right() - self::MARGIN;
        foreach ($lines as $l) {
            foreach ($this->wrap(self::ascii($l), $wide, 8.5) as $part) {
                $this->need(12);
                $this->draw($part, self::MARGIN, $this->y + 8.5, 8.5, false, '#333');
                $this->y += 11;
            }
        }
        $this->gap(10);
    }

    private function wrap(string $ascii, float $width, float $size, bool $bold = false): array {
        $words = preg_split('/\s+/', $ascii);
        $out = []; $cur = '';
        foreach ($words as $w) {
            $try = $cur === '' ? $w : $cur . ' ' . $w;
            if (self::widthOf($try, $size, $bold) > $width && $cur !== '') { $out[] = $cur; $cur = $w; }
            else $cur = $try;
        }
        if ($cur !== '') $out[] = $cur;
        return $out ?: [''];
    }

    /** A two-column key/value panel - the period summary, not a data table. */
    public function facts(string $title, array $rows): void {
        $this->need(30 + count($rows) * 13);
        $this->text($title, 10, true);
        $this->rule(self::ORANGE, 1.2);
        $this->gap(6);
        $vx = min(self::MARGIN + 300, $this->right() - 160);
        foreach ($rows as [$k, $v]) {
            $this->need(14);
            $this->draw(self::ascii($k), self::MARGIN, $this->y + 9, 9, false, '#555');
            $this->cell($v, $vx, $this->right() - $vx, 9, true, '#111', 'right');
            $this->y += 13;
        }
        $this->gap(10);
    }

    /**
     * The data table.
     *
     * Column widths come from a weight per TYPE, not from measuring the rows:
     * a table whose columns shift with whichever branch happened to have the
     * longest name looks different in every month's file copy, and two file
     * copies that do not look alike cannot be compared at a glance.
     */
    public function table(array $cols, array $rows, float $size = 7.0): void {
        $weight = ['txt' => 2.6, 'money' => 1.25, 'pct' => 0.9, 'int' => 0.85];
        $total = 0.0;
        foreach ($cols as $c) $total += $weight[$c['t']] ?? 1.0;
        $avail = $this->right() - self::MARGIN;
        $x = self::MARGIN;
        $lay = [];
        foreach ($cols as $c) {
            $w = $avail * (($weight[$c['t']] ?? 1.0) / $total);
            $lay[] = ['c' => $c, 'x' => $x, 'w' => $w - 4, 'align' => $c['t'] === 'txt' ? 'left' : 'right'];
            $x += $w;
        }

        /* A header that does not fit takes a second line rather than being cut
           short. "Kapana..", "Onceki done.." and "Degisim.." tell an accountant
           nothing, and a column whose name is unreadable is a column whose
           figures cannot be checked. */
        $headRow = function () use ($lay, $size) {
            $hs = $size - 0.5;
            $lines = []; $depth = 1;
            foreach ($lay as $i => $l) {
                $lines[$i] = $this->wrap(self::ascii($l['c']['tr']), $l['w'], $hs, true);
                $depth = max($depth, count($lines[$i]));
            }
            $top = $this->y;
            for ($n = 0; $n < $depth; $n++) {
                foreach ($lay as $i => $l) {
                    if (!isset($lines[$i][$n])) continue;
                    $this->cell($lines[$i][$n], $l['x'], $l['w'], $hs, true, '#666', $l['align']);
                }
                $this->y += $hs + 2;
            }
            $this->y = $top + $depth * ($hs + 2) + 2;
            $this->rule('#111', 0.7);
            $this->y += 3;
        };
        $this->need(60);
        $headRow();

        $n = count($rows);
        foreach ($rows as $i => $r) {
            if ($this->y + $size + 8 > $this->bottom()) { $this->addPage(); $headRow(); }
            $last = ($i === $n - 1);       // the TÜM ŞUBELER line
            if ($last) { $this->rule('#999', 0.8); $this->y += 4; }
            foreach ($lay as $l) {
                $k = $l['c']['k'];
                $this->cell(rapor_cell($r[$k] ?? null, $l['c']['t']), $l['x'], $l['w'],
                    $size, $last, $last ? self::ORANGE : '#111', $l['align']);
            }
            $this->y += $size + 5;
            if (!$last) { $this->rule('#EEE', 0.4); $this->y += 1; }
        }
        $this->gap(12);
    }

    /* ------------------------------ output ------------------------------ */

    public function output(): string {
        if ($this->buf !== '') { $this->pages[] = $this->buf; $this->buf = ''; }
        if (!$this->pages) $this->pages[] = '';
        $total = count($this->pages);

        /* The footer is stamped last because "Sayfa 1 / 3" cannot be written
           until the third page exists. A page count that is wrong is exactly
           the failure the footer is there to prevent. */
        foreach ($this->pages as $i => $stream) {
            $label = 'NOKTApp POS panel   -   Sayfa ' . ($i + 1) . ' / ' . $total;
            $this->pages[$i] = $stream . sprintf(
                "%s RG 0.5 w %.2f %.2f m %.2f %.2f l S\nBT /F1 7.50 Tf %s rg %.2f %.2f Td (%s) Tj ET\n",
                self::rgb('#ddd'), self::MARGIN, 34.0, self::W - self::MARGIN, 34.0,
                self::rgb('#8E8E96'), self::MARGIN, 22.0, self::esc(self::ascii($label)));
        }

        $objects = [];
        $add = function (string $body) use (&$objects): int { $objects[] = $body; return count($objects); };

        $fontReg = $add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
        $fontBold = $add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
        $pagesId = $add('');   // placeholder, filled in once the kids are known

        $kids = [];
        foreach ($this->pages as $stream) {
            $contentId = $add("<< /Length " . strlen($stream) . " >>\nstream\n" . $stream . "endstream");
            $pageId = $add(sprintf(
                "<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %.2f %.2f] /Resources << /Font << /F1 %d 0 R /F2 %d 0 R >> >> /Contents %d 0 R >>",
                $pagesId, self::W, self::H, $fontReg, $fontBold, $contentId));
            $kids[] = $pageId . ' 0 R';
        }
        $objects[$pagesId - 1] = "<< /Type /Pages /Count " . count($kids) . " /Kids [" . implode(' ', $kids) . "] >>";
        $catalog = $add("<< /Type /Catalog /Pages {$pagesId} 0 R >>");

        $out = "%PDF-1.4\n";
        $offsets = [];
        foreach ($objects as $i => $body) {
            $offsets[$i + 1] = strlen($out);
            $out .= ($i + 1) . " 0 obj\n" . $body . "\nendobj\n";
        }
        $xref = strlen($out);
        $n = count($objects) + 1;
        $out .= "xref\n0 {$n}\n0000000000 65535 f \n";
        for ($i = 1; $i < $n; $i++) $out .= sprintf("%010d 00000 n \n", $offsets[$i]);
        $out .= "trailer\n<< /Size {$n} /Root {$catalog} 0 R >>\nstartxref\n{$xref}\n%%EOF\n";
        return $out;
    }
}
