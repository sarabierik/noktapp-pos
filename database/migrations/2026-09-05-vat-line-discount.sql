-- ---------------------------------------------------------------------------
-- KDV: work it out on what was actually charged, and stop the roll-up triggers
-- fighting the order engine over orders.vat_total.
--
-- Two faults, both of which cost real money.
--
-- 1) The per-line trigger computed the tax from qty * unit_price and ignored
--    discount_amount, so a discounted line declared KDV on money the guest
--    never paid. It now uses line_total, which is qty * unit_price minus the
--    line's own discount - the definition of the line's gross.
--
-- 2) Three triggers rolled SUM(order_items.vat_total) onto orders.vat_total.
--    They summed soft-deleted lines back in - a cancelled kebab kept its tax on
--    the bill for the rest of the night - and they knew nothing about the
--    BILL-level discount, which only the order engine can spread across lines.
--    Worse, one of them fired at close time, when the stock module stamps
--    stock_applied on every line, and undid whatever recalc() had just settled.
--
--    So they are dropped. modules/orders.recalc() is now the single author of
--    orders.vat_total, alongside total / discount_total / grand_total, and it
--    runs inside the same transaction as every change to a line.
--
-- Idempotent: the desktop shell re-runs every migration on each start.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS `ai_order_items_vat`;
DROP TRIGGER IF EXISTS `trg_orders_vat_ad`;
DROP TRIGGER IF EXISTS `trg_orders_vat_after_item_update`;

DROP TRIGGER IF EXISTS `bi_order_items_vat`;
DROP TRIGGER IF EXISTS `bu_order_items_vat`;

DELIMITER $$

CREATE TRIGGER `bi_order_items_vat` BEFORE INSERT ON `order_items` FOR EACH ROW BEGIN
    DECLARE v_vat_rate DECIMAL(5,2) DEFAULT 0;

    -- read the rate off the product (tenant-safe), unless the caller set one
    IF NEW.vat_rate IS NULL OR NEW.vat_rate = 0 THEN
        SELECT vat_rate INTO v_vat_rate
          FROM products
         WHERE id = NEW.product_id AND client_id = NEW.client_id
         LIMIT 1;
        SET NEW.vat_rate = IFNULL(v_vat_rate, 0);
    END IF;

    -- KDV is INCLUSIVE: it comes out of the line, never on top of it, and the
    -- line's gross is what was charged for it - after its own discount
    IF NEW.vat_rate > 0 AND NEW.line_total > 0 THEN
        SET NEW.vat_total = ROUND((NEW.line_total * NEW.vat_rate) / (100 + NEW.vat_rate), 2);
    ELSE
        SET NEW.vat_total = 0;
    END IF;
END$$

CREATE TRIGGER `bu_order_items_vat` BEFORE UPDATE ON `order_items` FOR EACH ROW BEGIN
    IF NEW.vat_rate > 0 AND NEW.line_total > 0 AND NEW.is_deleted = 0 THEN
        SET NEW.vat_total = ROUND((NEW.line_total * NEW.vat_rate) / (100 + NEW.vat_rate), 2);
    ELSE
        SET NEW.vat_total = 0;
    END IF;
END$$

DELIMITER ;
