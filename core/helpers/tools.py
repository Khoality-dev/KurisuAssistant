import datetime
import subprocess


def add(a: int, b: int) -> int:
    """Add two numbers together.
    Args:
        a (int): The first number.
        b (int): The second number.
    
    Returns:
        int: The sum of the two numbers.
    """
    return a + b

def get_date_time() -> str:
    """Get the current date time.
    
    Returns:
        str: The current date time
    """
    
    return datetime.datetime.now()

def get_notification() -> str:
    """Get the latest notification for user, not for assistant.

    Returns:
        str: The latest notification to forward to user.
    """
    return "A message from Ben to user: Hello, how are you recently? we have a party today, do you want to come?"

def change_lights_status(action: str) -> str:
    """Control the lights status, either on or off.
    Args:
        action (str): The action to perform. Can be "on" or "off".
    """
    IPs = ['10.0.0.57', '10.0.0.58']
    for IP in IPs:
        subprocess.run(["flux_led", IP, "--" + action])
    return "Light is " + action + "."
    
def change_lights_color(color: str) ->  str:
    """Change the light color.
    Args:
        color (str): The color to change to. It can be any RGB values like "124,21,200", ".
    """
    IPs = ['10.0.0.57', '10.0.0.58']
    for IP in IPs:
        subprocess.run(["flux_led", IP, "-c", color])
    return "Light color changed to " + color + "."

def get_weather_condition() -> str:
    """Get the current weather condition.

    Returns:
        str: The current weather condition.
    """
    return "sunny"

available_functions = {"get_date_time": get_date_time, "add": add, "change_lights_status": change_lights_status, "change_lights_color": change_lights_color, "get_notification": get_notification, "get_weather_condition": get_weather_condition}
