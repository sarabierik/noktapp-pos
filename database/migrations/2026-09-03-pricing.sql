-- ---------------------------------------------------------------------------
-- FİYATLANDIRMA - hedef marj, maliyet kaynağı ve reddetme hafızası.
--
-- The PHP pricing module shipped five tables and used one and a half of them.
-- `pricing_suggestions` only ever received UPDATEs - nothing in the whole tree
-- ran an INSERT against it - so every list screen read an empty table, and
-- `pricing_strategy` (a single profit/volume enum) was read and written by
-- nothing at all. What was missing was not a table but the thing a restaurant
-- actually prices against: a TARGET MARGIN, per category, because a 70% drinks
-- margin and a 30% kitchen margin are different businesses sharing a till.
--
-- Three changes, all additive:
--
--   * `pricing_targets` - the target margin the suggestions aim at. Keyed on
--     (client_id, category_id) with category_id 0 meaning "the whole menu",
--     because a NULL there would not be caught by the unique key: MySQL treats
--     every NULL as distinct, so two "menu default" rows could exist side by
--     side and the later read would pick whichever the optimiser felt like.
--
--   * new columns on `pricing_suggestions` recording WHICH cost the suggestion
--     was built from. A suggested price computed off a hand-typed cost is a
--     different kind of claim from one computed off what the item actually
--     cost when it was sold, and a screen that shows both the same way is
--     lying by omission. `cost_source` carries that, and it is stored on the
--     row rather than recomputed later, because the answer changes as sales
--     accumulate and the suggestion has to be explainable after the fact.
--
--   * `rejected_by` / `reject_note`. The PHP wrote the rejecter's id into
--     `accepted_by` - the same column, for the opposite decision - so the
--     accepted-suggestions report and the rejected one disagreed about who had
--     done what. They are separate columns here.
--
-- Re-running this is harmless: every statement carries IF NOT EXISTS.
-- ---------------------------------------------------------------------------

-- Hedef marj. One row per category, plus the row with category_id=0 which is
-- the fallback for any category that has not been given its own target.
-- `target_margin` is a percentage of NET (KDV-hariç) revenue, never of the
-- shelf price: the KDV inside a menu price is the state's money, and a target
-- measured against it moves every time a VAT rate changes.
CREATE TABLE IF NOT EXISTS `pricing_targets` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `category_id` int(11) NOT NULL DEFAULT 0,
  `target_margin` decimal(5,2) NOT NULL DEFAULT 0.00,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `updated_by` int(11) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_pricing_target` (`client_id`,`category_id`),
  KEY `idx_pt_client` (`client_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Where the cost came from, what it was, and what the suggestion was aiming
-- at. Without these the row cannot be re-read six weeks later and explained.
ALTER TABLE `pricing_suggestions`
  ADD COLUMN IF NOT EXISTS `cost_price`     decimal(10,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS `cost_source`    varchar(16)   NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS `target_margin`  decimal(5,2)  NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS `current_margin` decimal(7,2)  NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS `vat_rate`       decimal(5,2)  NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS `rejected_by`    int(11)       DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `reject_note`    varchar(255)  DEFAULT NULL;

-- "Is there still a pending suggestion for this product" is asked once per
-- product on every batch run, and "has this product been rejected before" once
-- more; on a 300-item menu that is 600 scans of the table without this.
ALTER TABLE `pricing_suggestions`
  ADD KEY IF NOT EXISTS `idx_ps_client_product` (`client_id`,`product_id`,`accepted_at`,`rejected_at`);

-- The cost history is read newest-first per product on every product card and
-- once per product on every batch run. It only had an index on client_id.
ALTER TABLE `product_costs`
  ADD KEY IF NOT EXISTS `idx_pc_client_product_date` (`client_id`,`product_id`,`effective_date`);

-- Same for the two price histories, which the product card reads together.
ALTER TABLE `product_price_history`
  ADD KEY IF NOT EXISTS `idx_pph_client_product` (`client_id`,`product_id`,`effective_date`);
ALTER TABLE `price_change_log`
  ADD KEY IF NOT EXISTS `idx_pcl_client_product` (`client_id`,`product_id`,`changed_at`);
