-- ---------------------------------------------------------------------------
-- Akis denetimi: the audit trail that was not written, and a portion that was
-- rounded to a whole one.
--
-- 1) trg_audit_payment_delete looked the ACTOR up in `users` to decide which
--    tenant the audit row belonged to. The licence holder signs in against the
--    panel, not against a staff row, so their uid is 0 all the way down and
--    that lookup found nothing - client_id came out NULL, audit_logs.client_id
--    is NOT NULL, and the INSERT failed. The failure is inside the same
--    transaction as the void, so the OWNER - the one person the product says
--    may take money off the books - could not void a payment at all: the till
--    answered "Column 'client_id' cannot be null" and rolled the whole thing
--    back.
--
--    Even when the actor did have a row, deriving the tenant from whoever was
--    holding the mouse is wrong: the tenant of the record is the tenant of the
--    payment. payment_delete_logs already carries it, exactly as
--    order_delete_logs does for the bill-delete trigger next to it, which has
--    always been right. The `role` follows the same logic - it is read from
--    the actor when there is one, instead of being asserted as 'cashier'.
--
-- 2) order_item_cancel_events.qty was INT. Half portions (yarim porsiyon) are
--    a real thing the kitchen sells and the rest of the schema stores them as
--    DECIMAL, so cancelling half a portion wrote a whole one into the cancel
--    ledger - and that ledger is what the Z report's "iptal edilen satir"
--    figure is counted from. The BEFORE DELETE trigger on order_items feeds
--    the same column and had the same problem.
--
-- Idempotent: the desktop shell re-runs every migration on each start.
-- ---------------------------------------------------------------------------

ALTER TABLE `order_item_cancel_events`
  MODIFY COLUMN `qty` DECIMAL(10,2) NOT NULL;

DROP TRIGGER IF EXISTS `trg_audit_payment_delete`;

DELIMITER //
CREATE TRIGGER `trg_audit_payment_delete`
AFTER INSERT ON `payment_delete_logs`
FOR EACH ROW
BEGIN
    DECLARE v_role VARCHAR(50) DEFAULT 'cashier';

    SELECT `role` INTO v_role
      FROM `users`
     WHERE `id` = NEW.deleted_by AND `client_id` = NEW.client_id
     LIMIT 1;

    INSERT INTO `audit_logs`
        (client_id, actor_client_id, role, action, entity_type, entity_id,
         before_json, ip, user_agent, created_at)
    VALUES
        (NEW.client_id, NEW.deleted_by, IFNULL(v_role, 'cashier'), 'payment.delete',
         'payment', NEW.payment_id, NEW.original_data, NEW.ip_address, NEW.user_agent,
         NEW.deleted_at);
END//
DELIMITER ;
