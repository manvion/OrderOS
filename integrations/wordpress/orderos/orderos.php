<?php
/**
 * Plugin Name:       OrderOS — Online Ordering
 * Plugin URI:        https://orderos.ai/docs/wordpress
 * Description:       Add online ordering to your restaurant's WordPress site. Customers order and pay without ever leaving your website.
 * Version:           1.0.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            OrderOS
 * License:           GPL-2.0-or-later
 * Text Domain:       orderos
 */

// Direct file access is the oldest WordPress vulnerability there is. Bail.
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'ORDEROS_VERSION', '1.0.0' );
define( 'ORDEROS_DEFAULT_CDN', 'https://cdn.orderos.ai/widget.js' );

/**
 * The entire plugin: inject one <script> tag, and give the owner a settings page
 * to paste their key into.
 *
 * It deliberately does NOT reimplement the widget in PHP. The widget is a single
 * JS file that we can fix and ship without every restaurant updating a plugin —
 * which matters enormously, because restaurants do not update plugins.
 */
class OrderOS_Plugin {

	const OPTION_KEY = 'orderos_widget_key';
	const OPTION_CDN = 'orderos_cdn_url';

	public static function init() {
		$self = new self();

		add_action( 'wp_enqueue_scripts', array( $self, 'enqueue_widget' ) );
		add_action( 'admin_menu', array( $self, 'add_settings_page' ) );
		add_action( 'admin_init', array( $self, 'register_settings' ) );
		add_shortcode( 'orderos_menu', array( $self, 'inline_menu_shortcode' ) );
		add_shortcode( 'orderos_button', array( $self, 'button_shortcode' ) );

		add_filter(
			'plugin_action_links_' . plugin_basename( __FILE__ ),
			array( $self, 'settings_link' )
		);
	}

	/**
	 * Load the widget on the front end.
	 *
	 * `wp_enqueue_script` rather than echoing a tag into the footer: it makes the
	 * script play properly with caching plugins, deduplicates if some theme also
	 * adds it, and lets us set `defer` through the standard mechanism instead of
	 * fighting WordPress's script loader.
	 */
	public function enqueue_widget() {
		$key = trim( (string) get_option( self::OPTION_KEY, '' ) );

		// No key configured yet. Silently do nothing — never break the site.
		if ( empty( $key ) ) {
			return;
		}

		// Never load the ordering widget inside the WP admin or the block editor
		// preview; it would float a button over the owner's editing UI.
		if ( is_admin() ) {
			return;
		}

		$cdn = trim( (string) get_option( self::OPTION_CDN, ORDEROS_DEFAULT_CDN ) );
		if ( empty( $cdn ) ) {
			$cdn = ORDEROS_DEFAULT_CDN;
		}

		wp_enqueue_script(
			'orderos-widget',
			esc_url( $cdn ),
			array(),
			ORDEROS_VERSION,
			array(
				'strategy'  => 'defer',
				'in_footer' => true,
			)
		);

		// wp_enqueue_script gives us no way to add a data-* attribute, so we hook
		// the tag as it's rendered. `script_loader_tag` is the sanctioned way.
		add_filter(
			'script_loader_tag',
			function ( $tag, $handle ) use ( $key ) {
				if ( 'orderos-widget' !== $handle ) {
					return $tag;
				}
				return str_replace(
					' src=',
					' data-orderos-key="' . esc_attr( $key ) . '" src=',
					$tag
				);
			},
			10,
			2
		);
	}

	/**
	 * [orderos_menu] — drops the menu inline wherever the shortcode is placed.
	 * The widget's INLINE_MENU mode looks for exactly this container id.
	 */
	public function inline_menu_shortcode() {
		if ( empty( get_option( self::OPTION_KEY, '' ) ) ) {
			return '';
		}
		return '<div id="orderos-menu"></div>';
	}

	/**
	 * [orderos_button text="Order Now"] — a themed button anywhere in a page.
	 * Opens the same widget; uses the site's own button styles, so it inherits the
	 * restaurant's design rather than fighting it.
	 */
	public function button_shortcode( $atts ) {
		if ( empty( get_option( self::OPTION_KEY, '' ) ) ) {
			return '';
		}

		$atts = shortcode_atts(
			array( 'text' => __( 'Order Now', 'orderos' ) ),
			$atts,
			'orderos_button'
		);

		return sprintf(
			'<button type="button" class="orderos-open-button wp-block-button__link" onclick="window.OrderOS && window.OrderOS.open()">%s</button>',
			esc_html( $atts['text'] )
		);
	}

	// --- Settings ------------------------------------------------------------

	public function add_settings_page() {
		add_options_page(
			__( 'OrderOS', 'orderos' ),
			__( 'OrderOS', 'orderos' ),
			'manage_options',
			'orderos',
			array( $this, 'render_settings_page' )
		);
	}

	public function register_settings() {
		register_setting(
			'orderos',
			self::OPTION_KEY,
			array(
				'type'              => 'string',
				'sanitize_callback' => array( $this, 'sanitize_key' ),
				'default'           => '',
			)
		);

		register_setting(
			'orderos',
			self::OPTION_CDN,
			array(
				'type'              => 'string',
				'sanitize_callback' => 'esc_url_raw',
				'default'           => ORDEROS_DEFAULT_CDN,
			)
		);
	}

	/**
	 * Widget keys look like `wk_<32 hex>`. Validating the shape here means an owner
	 * who pastes the whole <script> tag (which they will) gets a clear error rather
	 * than a silently broken site.
	 */
	public function sanitize_key( $value ) {
		$value = trim( (string) $value );

		if ( '' === $value ) {
			return '';
		}

		// Be forgiving: if they pasted the whole snippet, pull the key out of it.
		if ( preg_match( '/data-orderos-key=["\']([a-z0-9_]+)["\']/i', $value, $matches ) ) {
			$value = $matches[1];
		}

		if ( ! preg_match( '/^wk_[a-f0-9]{32}$/i', $value ) ) {
			add_settings_error(
				self::OPTION_KEY,
				'invalid_key',
				__( 'That doesn\'t look like an OrderOS widget key. It should start with "wk_". Copy it from your OrderOS dashboard, under "My website".', 'orderos' )
			);
			// Keep the previous value rather than wiping a working configuration.
			return (string) get_option( self::OPTION_KEY, '' );
		}

		return $value;
	}

	public function render_settings_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}

		$key       = (string) get_option( self::OPTION_KEY, '' );
		$configured = ! empty( $key );
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'OrderOS — Online Ordering', 'orderos' ); ?></h1>

			<?php if ( $configured ) : ?>
				<div class="notice notice-success inline">
					<p>
						<strong><?php esc_html_e( 'Ordering is live on your site.', 'orderos' ); ?></strong>
						<?php esc_html_e( 'Visit your homepage — you should see the order button.', 'orderos' ); ?>
					</p>
				</div>
			<?php else : ?>
				<div class="notice notice-info inline">
					<p><?php esc_html_e( 'Paste your widget key below to switch ordering on.', 'orderos' ); ?></p>
				</div>
			<?php endif; ?>

			<form method="post" action="options.php">
				<?php settings_fields( 'orderos' ); ?>

				<table class="form-table" role="presentation">
					<tr>
						<th scope="row">
							<label for="orderos_widget_key"><?php esc_html_e( 'Widget key', 'orderos' ); ?></label>
						</th>
						<td>
							<input
								type="text"
								id="orderos_widget_key"
								name="<?php echo esc_attr( self::OPTION_KEY ); ?>"
								value="<?php echo esc_attr( $key ); ?>"
								class="regular-text code"
								placeholder="wk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
							/>
							<p class="description">
								<?php
								printf(
									/* translators: %s: dashboard URL */
									esc_html__( 'Find this in your OrderOS dashboard under %s. You can paste the whole code snippet — we\'ll pull the key out of it.', 'orderos' ),
									'<strong>My website</strong>'
								);
								?>
							</p>
						</td>
					</tr>

					<tr>
						<th scope="row">
							<label for="orderos_cdn_url"><?php esc_html_e( 'Widget URL', 'orderos' ); ?></label>
						</th>
						<td>
							<input
								type="url"
								id="orderos_cdn_url"
								name="<?php echo esc_attr( self::OPTION_CDN ); ?>"
								value="<?php echo esc_attr( get_option( self::OPTION_CDN, ORDEROS_DEFAULT_CDN ) ); ?>"
								class="regular-text code"
							/>
							<p class="description">
								<?php esc_html_e( 'Leave this alone unless OrderOS support tells you otherwise (or you self-host).', 'orderos' ); ?>
							</p>
						</td>
					</tr>
				</table>

				<?php submit_button( __( 'Save', 'orderos' ) ); ?>
			</form>

			<hr />

			<h2><?php esc_html_e( 'Placing the widget yourself', 'orderos' ); ?></h2>
			<p><?php esc_html_e( 'By default a floating "Order Now" button appears on every page. If you\'d rather place things by hand, these shortcodes work in any page, post or block:', 'orderos' ); ?></p>

			<table class="widefat striped" style="max-width:720px">
				<thead>
					<tr>
						<th><?php esc_html_e( 'Shortcode', 'orderos' ); ?></th>
						<th><?php esc_html_e( 'What it does', 'orderos' ); ?></th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td><code>[orderos_menu]</code></td>
						<td><?php esc_html_e( 'Embeds your full menu right there in the page. Set the widget to "Menu embedded in the page" in your OrderOS dashboard first.', 'orderos' ); ?></td>
					</tr>
					<tr>
						<td><code>[orderos_button text="Order Now"]</code></td>
						<td><?php esc_html_e( 'A button that opens the ordering window. Styled by your theme.', 'orderos' ); ?></td>
					</tr>
				</tbody>
			</table>

			<h2><?php esc_html_e( 'Not working?', 'orderos' ); ?></h2>
			<ol>
				<li><?php esc_html_e( 'Check that this site\'s domain is registered in your OrderOS dashboard, under "My website". The widget only runs on domains you\'ve registered.', 'orderos' ); ?></li>
				<li><?php esc_html_e( 'Check that your ordering page is published in OrderOS (Settings → Publish).', 'orderos' ); ?></li>
				<li><?php esc_html_e( 'If you use a caching plugin, clear the cache after saving.', 'orderos' ); ?></li>
			</ol>
		</div>
		<?php
	}

	public function settings_link( $links ) {
		$settings = sprintf(
			'<a href="%s">%s</a>',
			esc_url( admin_url( 'options-general.php?page=orderos' ) ),
			esc_html__( 'Settings', 'orderos' )
		);
		array_unshift( $links, $settings );
		return $links;
	}
}

OrderOS_Plugin::init();
