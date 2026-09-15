<?php
/**
 * pos.noktapp.com now serves one thing: the control panel.
 * Anyone landing on the bare domain goes to the login.
 */
header('Location: admin/index.php', true, 302);
exit;
